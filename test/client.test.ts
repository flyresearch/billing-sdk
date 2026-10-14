import { expect, test } from "bun:test";
import {
  BillingError,
  createBillingClient,
  createMeter,
  type Standing,
} from "../src/index";

const answering = (respond: (body: unknown) => Response | Promise<Response>) =>
  createBillingClient({
    baseUrl: "https://billing.test",
    apiKey: "k",
    fetch: (async (_input: string | URL | Request, init?: RequestInit) =>
      respond(
        init?.body ? JSON.parse(String(init.body)) : undefined,
      )) as unknown as typeof fetch,
  });

test("a success whose body is not a JSON object is an error, not an empty result", async () => {
  for (const body of [
    "<html>proxy page</html>",
    "",
    "[]",
    "null",
    '"x"',
    "1",
  ]) {
    const client = answering(() => new Response(body, { status: 200 }));
    const error = await client.balance("u").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BillingError);
    expect({ body, error }).toMatchObject({
      body,
      error: { status: 200, code: "invalid_response" },
    });
  }
});

test("a refusal keeps its status and code, whatever its body", async () => {
  const coded = answering(() =>
    Response.json({ code: "event_conflict", message: "m" }, { status: 409 }),
  );
  expect(await coded.balance("u").catch((e: unknown) => e)).toMatchObject({
    status: 409,
    code: "event_conflict",
  });
  const bare = answering(() => new Response("[]", { status: 502 }));
  expect(await bare.balance("u").catch((e: unknown) => e)).toMatchObject({
    status: 502,
    code: "502",
  });
});

// A scripted Billing: each usage report gets the next answer.
function scripted(answers: Array<() => Response>) {
  const sent: Array<{ event_id: string; units: string }> = [];
  const client = answering((body) => {
    sent.push(body as { event_id: string; units: string });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next();
  });
  return { client, sent };
}
const ok = (balance: number) => () =>
  Response.json({
    event_id: "x",
    credits: "1",
    balance: String(balance),
    allowed: balance > 0,
  });
const refuse = (status: number, code: string) => () =>
  Response.json({ code, message: code }, { status });

test("createMeter retries transient failures under the same event id", async () => {
  const { client, sent } = scripted([
    refuse(503, "try_again_later"),
    refuse(429, "too_many_pending_requests"),
    () => new Response("<html>gateway</html>", { status: 200 }),
    () => {
      throw new TypeError("fetch failed");
    },
    ok(90),
  ]);
  const errors: unknown[] = [];
  const meter = createMeter(client, {
    customer: "u",
    eventPrefix: "s",
    intervalMs: 60_000,
    onError: (e) => errors.push(e),
  });
  meter.add(10);
  for (let i = 0; i < 4; i++) await meter.flush().catch(() => {});
  await meter.close();
  expect(errors).toHaveLength(4);
  expect(sent.map((s) => s.event_id)).toEqual([
    "s:1",
    "s:1",
    "s:1",
    "s:1",
    "s:1",
  ]);
});

test("createMeter drops a refused batch and reports the next under a new id", async () => {
  const { client, sent } = scripted([refuse(422, "invalid_metadata"), ok(90)]);
  const errors: unknown[] = [];
  const meter = createMeter(client, {
    customer: "u",
    eventPrefix: "s",
    intervalMs: 60_000,
    onError: (e) => errors.push(e),
  });
  meter.add(10);
  await expect(meter.flush()).rejects.toMatchObject({
    code: "invalid_metadata",
  });
  meter.add(5);
  await meter.close();
  expect(errors).toHaveLength(1);
  expect(sent).toEqual([
    { event_id: "s:1", units: "10" },
    { event_id: "s:2", units: "5" },
  ]);
});

test("createMeter stops once on account_closed and reports nothing more", async () => {
  const { client, sent } = scripted([ok(40), refuse(409, "account_closed")]);
  const stops: Standing[] = [];
  const errors: unknown[] = [];
  const meter = createMeter(client, {
    customer: "u",
    eventPrefix: "s",
    intervalMs: 60_000,
    onStop: (s) => stops.push(s),
    onError: (e) => errors.push(e),
  });
  meter.add(10);
  await meter.flush();
  meter.add(5);
  await meter.flush();
  meter.add(7);
  await meter.flush();
  await meter.close();
  expect(stops).toEqual([{ balance: "40", allowed: true }]);
  expect(meter.stopped).toBe(true);
  expect(errors).toEqual([]);
  expect(sent.map((s) => s.event_id)).toEqual(["s:1", "s:2"]);
});

test("createMeter without a known standing stops with a zero balance on account_closed", async () => {
  const { client } = scripted([refuse(409, "account_closed")]);
  const stops: Standing[] = [];
  const meter = createMeter(client, {
    customer: "u",
    eventPrefix: "s",
    intervalMs: 60_000,
    onStop: (s) => stops.push(s),
  });
  meter.add(1);
  await meter.close();
  expect(stops).toEqual([{ balance: "0", allowed: false }]);
});
