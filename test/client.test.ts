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

test("a refused key (401) keeps the batch for retry under the same event id", async () => {
  const sent: string[] = [];
  let refuse = true;
  const client = createBillingClient({
    baseUrl: "https://billing.test",
    apiKey: "k",
    fetch: (async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)).event_id);
      return refuse
        ? Response.json({ code: "unauthorized" }, { status: 401 })
        : Response.json({
            event_id: "x",
            credits: "5",
            balance: "95",
            allowed: true,
          });
    }) as unknown as typeof fetch,
  });
  const meter = createMeter(client, {
    customer: "u",
    eventPrefix: "s",
    intervalMs: 60_000,
    onError: () => {},
  });
  meter.add(5);
  await meter.flush().catch(() => {});
  refuse = false;
  await meter.close();
  expect(sent).toEqual(["s:1", "s:1"]);
});

test("no request carries an Idempotency-Key", async () => {
  const headers: Headers[] = [];
  const client = createBillingClient({
    baseUrl: "https://billing.test",
    apiKey: "k",
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      return Response.json({});
    }) as unknown as typeof fetch,
  });
  await client.checkout("u", { sku: "s", purchase_ref: "p" });
  await client.createTopupSession("u");
  await client.reportUsage("u", { event_id: "e", units: "1" });
  expect(headers).toHaveLength(3);
  expect(headers.every((h) => !h.has("idempotency-key"))).toBe(true);
});

test("the fake simulates a subscription: checkout, payment, a charged switch, a free switch back, renewal and cancellation", async () => {
  const { createTestBilling } = await import("../src/testing");
  let at = Date.UTC(2026, 0, 10);
  const billing = await createTestBilling({
    now: () => at,
    plans: [
      { sku: "free", price: "0", credits: "100" },
      { sku: "starter", price: "990", credits: "1000" },
      { sku: "pro", price: "4990", credits: "5000" },
    ],
  });
  const client = createBillingClient({
    ...billing.config,
    fetch: billing.fetch,
  });
  const code = (p: Promise<unknown>) =>
    p.then(
      () => "accepted",
      (e: BillingError) => `${e.status} ${e.code}`,
    );
  expect((await client.plan("u")).plan?.sku).toBe("free");
  const receipt = await client.subscriptionCheckout("u", {
    plan_sku: "starter",
    purchase_ref: "r1",
  });
  expect(receipt.state).toBe("checkout");
  expect(receipt.checkout_url).toStartWith("https://");
  // The same purchase_ref answers the same subscription.
  expect(
    (
      await client.subscriptionCheckout("u", {
        plan_sku: "starter",
        purchase_ref: "r1",
      })
    ).subscription_id,
  ).toBe(receipt.subscription_id);
  await billing.paySubscription(receipt.subscription_id);
  let view = await client.plan("u");
  expect(view.plan?.sku).toBe("starter");
  expect(view.subscription?.current_period_end).toBe(
    "2026-02-10T00:00:00.000Z",
  );
  expect(view.allowance?.total).toBe("1000");
  expect(
    await code(
      client.subscriptionCheckout("u", { plan_sku: "pro", purchase_ref: "r2" }),
    ),
  ).toBe("409 subscription_exists");
  // Up: charged, topped up to pro's credits. Down and back up: free.
  expect((await client.changePlan("u", "pro")).allowance?.total).toBe("5000");
  await client.changePlan("u", "starter");
  expect((await client.changePlan("u", "pro")).allowance?.total).toBe("5000");
  expect(await code(client.changePlan("u", "pro"))).toBe("409 plan_unchanged");
  // Renewal: the next period's credits; the last period's left expire.
  at = Date.UTC(2026, 1, 10, 1);
  view = await client.plan("u");
  expect(view.subscription?.current_period_end).toBe(
    "2026-03-10T00:00:00.000Z",
  );
  expect(view.allowance).toEqual({
    total: "5000",
    remaining: "5000",
    expires_at: "2026-03-10T00:00:00.000Z",
  });
  expect(
    (await client.cancelPlan("u")).subscription?.cancel_at_period_end,
  ).toBe(true);
  expect(
    (await client.resumePlan("u")).subscription?.cancel_at_period_end,
  ).toBe(false);
  await client.cancelPlan("u");
  expect((await client.billingPortal("u")).url).toStartWith("https://");
  // After the period: back on the free plan.
  at = Date.UTC(2026, 2, 10, 1);
  view = await client.plan("u");
  expect(view.plan?.sku).toBe("free");
  expect(view.subscription).toBeNull();
  expect(await code(client.cancelPlan("u"))).toBe("409 subscription_required");
});
