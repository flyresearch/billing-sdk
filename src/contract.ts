// 公开接口（API v1，ADR-0014）的契约测试。同一套测试在本仓库对内存假服务跑，
// 在 Billing 仓库对真服务跑；两边都通过，才说明假服务的行为与生产一致。用 bun:test。
import { afterEach, describe, expect, test } from "bun:test";
import {
  BillingError,
  createBillingClient,
  createMeter,
  type Standing,
} from "./index";
import type { CreateTestBilling, TestBillingOptions } from "./testing";

export function contractSuite(name: string, create: CreateTestBilling) {
  describe(`Billing API v1 contract: ${name}`, () => {
    const opened: Array<() => void> = [];
    afterEach(() => {
      while (opened.length) opened.pop()!();
    });
    async function world(options?: TestBillingOptions) {
      const billing = await create(options);
      opened.push(billing.close);
      const client = createBillingClient({
        ...billing.config,
        fetch: billing.fetch,
      });
      const raw = async (method: string, path: string, body?: unknown) => {
        const response = await billing.fetch(
          new URL(path, billing.config.baseUrl),
          {
            method,
            headers: {
              authorization: `Bearer ${billing.config.apiKey}`,
              ...(body === undefined
                ? {}
                : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
        );
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      };
      return { billing, client, raw };
    }
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => "accepted",
        (error: unknown) => {
          if (error instanceof BillingError)
            return `${error.status} ${error.code}`;
          throw error;
        },
      );

    test("a wrong product key is 401 unauthorized", async () => {
      const { billing } = await world();
      const client = createBillingClient({
        ...billing.config,
        apiKey: "wrong",
        fetch: billing.fetch,
      });
      expect(await code(client.balance("u"))).toBe("401 unauthorized");
    });

    test("an unknown customer has a zero balance and may not start", async () => {
      const { client } = await world();
      expect(await client.balance("u")).toMatchObject({
        balance: "0",
        allowed: false,
      });
    });

    test("granted credits allow work", async () => {
      const { billing, client } = await world();
      await billing.grant("u", "100");
      expect(await client.balance("u")).toMatchObject({
        balance: "100",
        allowed: true,
      });
    });

    test("usage is charged at the product's rate and always recorded, even past zero", async () => {
      const { billing, client } = await world({ creditsPerUnit: 3 });
      await billing.grant("u", "100");
      expect(
        await client.reportUsage("u", { event_id: "s:1", units: "30" }),
      ).toEqual({
        event_id: "s:1",
        credits: "90",
        balance: "10",
        allowed: true,
      });
      expect(
        await client.reportUsage("u", { event_id: "s:2", units: "5" }),
      ).toEqual({
        event_id: "s:2",
        credits: "15",
        balance: "-5",
        allowed: false,
      });
    });

    test("an event_id replays its result; other content under it is event_conflict", async () => {
      const { billing, client } = await world();
      await billing.grant("u", "100");
      await client.reportUsage("u", {
        event_id: "s:1",
        units: "30",
        metadata: { session: "s" },
      });
      expect(
        await client.reportUsage("u", {
          event_id: "s:1",
          units: "30",
          metadata: { session: "s" },
        }),
      ).toMatchObject({
        credits: "30",
        balance: "70",
      });
      expect(
        await code(
          client.reportUsage("u", {
            event_id: "s:1",
            units: "31",
            metadata: { session: "s" },
          }),
        ),
      ).toBe("409 event_conflict");
      expect(
        await code(client.reportUsage("u", { event_id: "s:1", units: "30" })),
      ).toBe("409 event_conflict");
      expect(
        await code(
          client.reportUsage("v", {
            event_id: "s:1",
            units: "30",
            metadata: { session: "s" },
          }),
        ),
      ).toBe("409 event_conflict");
      expect((await client.balance("u")).balance).toBe("70");
    });

    test("bad usage input is refused with a 422 naming what was wrong, and charges nothing", async () => {
      const { billing, raw, client } = await world();
      await billing.grant("u", "100");
      for (const [body, code] of [
        [{ event_id: "a", units: 5 }, "invalid_integer"],
        [{ event_id: "a", units: "-5" }, "invalid_integer"],
        [{ event_id: "a", units: "1.5" }, "invalid_integer"],
        [{ event_id: "a", units: "1e3" }, "invalid_integer"],
        [{ event_id: "", units: "5" }, "invalid_identifier"],
        [{ units: "5" }, "invalid_identifier"],
        [{ event_id: "a", units: "5", extra: 1 }, "unexpected_field"],
        [{ event_id: "a", units: "5", metadata: { n: 1 } }, "invalid_metadata"],
        [
          { event_id: "a", units: "5", metadata: { big: "x".repeat(2000) } },
          "invalid_metadata",
        ],
      ] as const) {
        const result = await raw("POST", "/v1/customers/u/usage", body);
        expect({ body, status: result.status, code: result.body.code }).toEqual(
          { body, status: 422, code },
        );
      }
      expect((await client.balance("u")).balance).toBe("100");
    });

    test("history is newest first, typed, paged by cursor and filterable", async () => {
      const { billing, client } = await world();
      await billing.purchase("u", "1000");
      await billing.grant("u", "5");
      for (let i = 1; i <= 52; i++)
        await client.reportUsage("u", {
          event_id: `s:${i}`,
          units: "1",
          metadata: { i: String(i) },
        });
      const first = await client.history("u");
      expect(first.data).toHaveLength(50);
      expect(first.data[0]).toMatchObject({
        type: "usage",
        credits: "-1",
        balance_after: "953",
        event_id: "s:52",
        metadata: { i: "52" },
      });
      expect(typeof first.data[0]!.id).toBe("string");
      expect(Number.isFinite(Date.parse(first.data[0]!.created_at))).toBe(true);
      const second = await client.history("u", { cursor: first.next_cursor! });
      expect(second.data.map((e) => e.type)).toEqual([
        "usage",
        "usage",
        "adjustment",
        "purchase",
      ]);
      expect(second.data[3]).toMatchObject({
        credits: "1000",
        balance_after: "1000",
        order: { state: "fulfilled" },
      });
      expect(second.next_cursor).toBeNull();
      expect(
        (await client.history("u", { type: "purchase" })).data,
      ).toHaveLength(1);
      expect((await client.history("other")).data).toEqual([]);
    });

    test("a top-up link is a 30-minute URL on the service; a return path needs a return origin", async () => {
      const now = Date.parse("2026-10-14T00:00:00.000Z");
      const plain = await world({ now: () => now });
      const link = await plain.client.createTopupSession("u");
      expect(
        link.url.startsWith(`${plain.billing.config.baseUrl}/topup/`),
      ).toBe(true);
      expect(Date.parse(link.expires_at) - now).toBe(30 * 60_000);
      expect(
        await code(
          plain.client.createTopupSession("u", { return_path: "/billing" }),
        ),
      ).toBe("422 return_origin_not_configured");
      const configured = await world({ returnOrigin: "https://product.test" });
      expect(
        await code(
          configured.client.createTopupSession("u", {
            return_path: "/billing",
          }),
        ),
      ).toBe("accepted");
      expect(
        await code(
          configured.client.createTopupSession("u", {
            return_path: "https://evil.test",
          }),
        ),
      ).toBe("422 invalid_return_path");
      const unpaid = await world({ payments: false });
      expect(await code(unpaid.client.createTopupSession("u"))).toBe(
        "503 stripe_not_configured",
      );
    });

    test("a debt is paid off by the next purchase", async () => {
      const { billing, client } = await world();
      await client.reportUsage("u", { event_id: "s:1", units: "40" });
      await billing.purchase("u", "100");
      expect(await client.balance("u")).toMatchObject({
        balance: "60",
        allowed: true,
      });
    });

    test("createMeter reports batches under rising event ids and stops once", async () => {
      const { billing, client } = await world();
      await billing.grant("u", "100");
      const stops: Standing[] = [];
      const meter = createMeter(client, {
        customer: "u",
        eventPrefix: "session-1",
        intervalMs: 60_000,
        metadata: { agent: "support" },
        onStop: (s) => stops.push(s),
      });
      meter.add(30);
      meter.add(10);
      await meter.flush();
      meter.add(70);
      await meter.flush();
      meter.add(5);
      await meter.close();
      expect(stops).toEqual([{ balance: "-10", allowed: false }]);
      expect(meter.stopped).toBe(true);
      const usage = (await client.history("u", { type: "usage" })).data.map(
        (e) => [e.event_id, e.credits],
      );
      expect(usage).toEqual([
        ["session-1:3", "-5"],
        ["session-1:2", "-70"],
        ["session-1:1", "-40"],
      ]);
      const usageEntries = (await client.history("u", { type: "usage" })).data;
      expect(usageEntries.every((e) => e.metadata?.agent === "support")).toBe(
        true,
      );
    });

    test("createMeter retries a failed batch under the same event id, so nothing is charged twice", async () => {
      const { billing } = await world();
      await billing.grant("u", "100");
      let failNext = true;
      // The request reaches Billing, but its response is lost.
      const lossy: typeof fetch = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const response = await billing.fetch(input, init);
        if (failNext) {
          failNext = false;
          throw new Error("connection reset");
        }
        return response;
      }) as typeof fetch;
      const client = createBillingClient({ ...billing.config, fetch: lossy });
      const errors: unknown[] = [];
      const meter = createMeter(client, {
        customer: "u",
        eventPrefix: "s",
        intervalMs: 60_000,
        onError: (e) => errors.push(e),
      });
      meter.add(30);
      await expect(meter.flush()).rejects.toThrow("connection reset");
      meter.add(5);
      await meter.close();
      expect(errors).toHaveLength(1);
      const usage = (await client.history("u", { type: "usage" })).data.map(
        (e) => [e.event_id, e.credits],
      );
      expect(usage).toEqual([
        ["s:2", "-5"],
        ["s:1", "-30"],
      ]);
      expect((await client.balance("u")).balance).toBe("65");
    });
  });
}
