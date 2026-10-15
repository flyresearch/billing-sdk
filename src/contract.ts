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
        meter_version: "v1",
      });
      expect(
        await client.reportUsage("u", { event_id: "s:2", units: "5" }),
      ).toEqual({
        event_id: "s:2",
        credits: "15",
        balance: "-5",
        allowed: false,
        meter_version: "v1",
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
      expect(first.has_more).toBe(true);
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
      expect(second.has_more).toBe(false);
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

    test("every top-up session call opens a new link", async () => {
      const { client } = await world({ returnOrigin: "https://product.test" });
      const first = await client.createTopupSession("u");
      const second = await client.createTopupSession("u");
      expect(second.url).not.toBe(first.url);
      const routed = await client.createTopupSession("u", {
        return_path: "/billing",
      });
      expect(
        await client.createTopupSession("u", { return_path: "/billing" }),
      ).not.toEqual(routed);
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

    test("createMeter drops a batch Billing refuses and goes on with the next", async () => {
      const { billing, client } = await world();
      await billing.grant("u", "100");
      // s:1 is taken with other content, so the meter's first batch is refused.
      await client.reportUsage("u", { event_id: "s:1", units: "1" });
      const errors: unknown[] = [];
      const meter = createMeter(client, {
        customer: "u",
        eventPrefix: "s",
        intervalMs: 60_000,
        onError: (e) => errors.push(e),
      });
      meter.add(30);
      expect(await code(meter.flush())).toBe("409 event_conflict");
      meter.add(5);
      await meter.close();
      expect(errors).toHaveLength(1);
      const usage = (await client.history("u", { type: "usage" })).data.map(
        (e) => [e.event_id, e.credits],
      );
      expect(usage).toEqual([
        ["s:2", "-5"],
        ["s:1", "-1"],
      ]);
    });

    // 自建购买页：catalog 列出额度包，checkout 建单，order 读结果。
    const packs = {
      offers: [
        { sku: "pack-100", currency: "usd", amount: "500", credits: "100" },
        {
          kind: "flexible" as const,
          sku: "custom",
          currency: "usd",
          min_amount: "100",
          max_amount: "10000",
          step: "100",
          credits_per_unit: "3",
          amount: "1000",
        },
      ],
    };

    test("the catalog lists offers with their quote version; without payments it is empty", async () => {
      const { client } = await world(packs);
      const catalog = await client.catalog();
      expect(catalog.payment_methods).toContain("card");
      expect(catalog.offers.map((o) => o.sku)).toEqual(["pack-100", "custom"]);
      const [fixed, flexible] = catalog.offers;
      expect(fixed).toMatchObject({
        amount: "500",
        currency: "usd",
        credits: "100",
        amount_decimals: 2,
      });
      expect(fixed!.kind ?? "fixed").toBe("fixed");
      expect(typeof fixed!.offer_version).toBe("string");
      expect(flexible).toMatchObject({
        kind: "flexible",
        min_amount: "100",
        max_amount: "10000",
        step: "100",
        credits_per_unit: "3",
        amount: "1000",
        credits: "3000",
      });
      const unpaid = await world({ ...packs, payments: false });
      expect(await unpaid.client.catalog()).toMatchObject({
        offers: [],
        payment_methods: [],
      });
      expect(
        await code(
          unpaid.client.checkout("u", { sku: "pack-100", purchase_ref: "p1" }),
        ),
      ).toBe("503 stripe_not_configured");
    });

    test("checkout creates one order per purchase_ref; paying it credits the customer", async () => {
      const { billing, client } = await world(packs);
      const receipt = await client.checkout("u", {
        sku: "pack-100",
        purchase_ref: "p1",
      });
      // The checkout URL comes back at once, with the order.
      expect(receipt).toMatchObject({ state: "awaiting_payment" });
      if (!("order_id" in receipt)) throw new Error("expected an order");
      expect(typeof receipt.checkout_url).toBe("string");
      // A retry under the same purchase_ref names the same order and checkout.
      expect(
        await client.checkout("u", { sku: "pack-100", purchase_ref: "p1" }),
      ).toEqual(receipt);
      // Other fields may differ on a retry; the purchase_ref still names it.
      expect(
        await client.checkout("u", {
          sku: "pack-100",
          purchase_ref: "p1",
          payment_method: "card",
        }),
      ).toMatchObject({ order_id: receipt.order_id });
      const order = await client.order("u", receipt.order_id);
      expect(order).toMatchObject({
        id: receipt.order_id,
        purchase_ref: "p1",
        sku: "pack-100",
        amount: "500",
        currency: "usd",
        credits: "100",
        state: "awaiting_payment",
        exception: null,
      });
      expect((await client.orders("u")).data.map((o) => o.id)).toEqual([
        receipt.order_id,
      ]);
      expect(await code(client.order("v", receipt.order_id))).toBe(
        "404 not_found",
      );
      await client.reportUsage("u", { event_id: "s:1", units: "30" });
      await billing.payOrder(receipt.order_id);
      expect(await client.order("u", receipt.order_id)).toMatchObject({
        state: "fulfilled",
      });
      // A replay after payment answers the same order as it is now.
      expect(
        await client.checkout("u", { sku: "pack-100", purchase_ref: "p1" }),
      ).toMatchObject({ order_id: receipt.order_id, state: "fulfilled" });
      // The purchase pays the debt off first.
      expect(await client.balance("u")).toMatchObject({
        balance: "70",
        allowed: true,
      });
      const [purchase] = (await client.history("u", { type: "purchase" })).data;
      expect(purchase).toMatchObject({
        type: "purchase",
        credits: "100",
        order: { id: receipt.order_id, amount: "500", currency: "usd" },
      });
    });

    test("checkout dedupes a long, non-ASCII customer and purchase_ref", async () => {
      const { client } = await world(packs);
      const customer = `用户-${"x".repeat(180)}`;
      const ref = "r".repeat(190);
      const receipt = await client.checkout(customer, {
        sku: "pack-100",
        purchase_ref: ref,
      });
      expect(receipt).toMatchObject({ state: "awaiting_payment" });
      expect(
        await client.checkout(customer, { sku: "pack-100", purchase_ref: ref }),
      ).toEqual(receipt);
    });

    test("two customers may use the same purchase_ref; each gets their own order", async () => {
      const { client } = await world(packs);
      const a = await client.checkout("u", {
        sku: "pack-100",
        purchase_ref: "1",
      });
      const b = await client.checkout("v", {
        sku: "pack-100",
        purchase_ref: "1",
      });
      if (!("order_id" in a) || !("order_id" in b))
        throw new Error("expected orders");
      expect(a.order_id).not.toBe(b.order_id);
      expect(await client.order("v", b.order_id)).toMatchObject({
        purchase_ref: "1",
      });
    });

    test("checkout refusals: changed sku, stale quote, bad amounts", async () => {
      const { client } = await world(packs);
      await client.checkout("u", { sku: "pack-100", purchase_ref: "p1" });
      expect(
        await code(
          client.checkout("u", {
            sku: "custom",
            purchase_ref: "p1",
            amount: "1000",
          }),
        ),
      ).toBe("422 unsupported_sku");
      expect(
        await code(client.checkout("u", { sku: "nope", purchase_ref: "p2" })),
      ).toBe("422 unsupported_sku");
      // A stale quote is a definitive refusal of the purchase, not an error.
      expect(
        await client.checkout("u", {
          sku: "pack-100",
          purchase_ref: "p3",
          offer_version: "stale",
        }),
      ).toEqual({ state: "rejected", reason: "offer_changed" });
      const version = (await client.catalog()).offers[0]!.offer_version;
      // A refused purchase_ref stays refused, even with the current quote or
      // none; the payer confirms again under a new purchase_ref.
      for (const retry of [{ offer_version: version }, {}])
        expect(
          await client.checkout("u", {
            sku: "pack-100",
            purchase_ref: "p3",
            ...retry,
          }),
        ).toEqual({ state: "rejected", reason: "offer_changed" });
      expect(
        (await client.orders("u")).data.map((o) => o.purchase_ref),
      ).toEqual(["p1"]);
      expect(
        await client.checkout("u", {
          sku: "pack-100",
          purchase_ref: "p4",
          offer_version: version,
        }),
      ).toMatchObject({ state: "awaiting_payment" });
      expect(
        await code(
          client.checkout("u", {
            sku: "pack-100",
            purchase_ref: "p5",
            amount: "500",
          }),
        ),
      ).toBe("422 amount_not_accepted");
      for (const amount of ["50", "10100", "150"])
        expect(
          await code(
            client.checkout("u", {
              sku: "custom",
              purchase_ref: `p6-${amount}`,
              amount,
            }),
          ),
        ).toBe("422 amount_out_of_range");
      const flexible = await client.checkout("u", {
        sku: "custom",
        purchase_ref: "p7",
        amount: "2000",
      });
      if (!("order_id" in flexible)) throw new Error("expected an order");
      expect(await client.order("u", flexible.order_id)).toMatchObject({
        amount: "2000",
        credits: "6000",
      });
      expect(
        await code(
          client.checkout("u", {
            sku: "pack-100",
            purchase_ref: "p8",
            payment_method: "bitcoin",
          }),
        ),
      ).toBe("422 unsupported_payment_method");
      expect(
        await code(
          client.checkout("u", {
            sku: "pack-100",
            purchase_ref: "p9",
            return_path: "/billing",
          }),
        ),
      ).toBe("422 return_origin_not_configured");
      const routed = await world({
        ...packs,
        returnOrigin: "https://product.test",
      });
      expect(
        await routed.client.checkout("u", {
          sku: "pack-100",
          purchase_ref: "p9",
          return_path: "/billing",
        }),
      ).toMatchObject({ state: "awaiting_payment" });
    });

    // ---- plans (ADR-0015) ----
    const PRO = {
      sku: "pro",
      name: "Pro",
      price: "990",
      credits: "1000",
      entitlements: { rpm: 60 },
    };
    const FREE = {
      sku: "free",
      name: "Free",
      price: "0",
      credits: "100",
      entitlements: { rpm: 5 },
    };
    const PLANS = [PRO, FREE];

    test("catalog lists the plans cheapest first, entitlements as given; without plans a user has none", async () => {
      const { client } = await world({ plans: PLANS });
      expect((await client.catalog()).plans).toEqual([
        { ...FREE, currency: "usd" },
        { ...PRO, currency: "usd" },
      ]);
      const none = await world();
      expect((await none.client.catalog()).plans).toEqual([]);
      expect(await none.client.plan("u")).toEqual({
        plan: null,
        period_end: null,
        allowance: null,
        subscription: null,
      });
    });

    test("the free plan grants its credits once a month on first read; they are spent first and expire at the month's end", async () => {
      let at = Date.UTC(2026, 0, 10, 12);
      const { billing, client } = await world({
        plans: PLANS,
        offers: [{ sku: "pack-100", amount: "100", credits: "100" }],
        now: () => at,
      });
      const first = await client.plan("u");
      expect(first.plan?.sku).toBe("free");
      expect(first.period_end).toBe("2026-02-01T00:00:00.000Z");
      expect(first.allowance).toEqual({
        total: "100",
        remaining: "100",
        expires_at: "2026-02-01T00:00:00.000Z",
      });
      expect(first.subscription).toBeNull();
      await billing.purchase("u", "50");
      await client.reportUsage("u", { event_id: "e1", units: "30" });
      expect((await client.plan("u")).allowance?.remaining).toBe("70");
      expect((await client.balance("u")).balance).toBe("120");
      // The next month: the 70 left expire, the new month's 100 arrive.
      at = Date.UTC(2026, 1, 1, 0, 0, 1);
      expect((await client.balance("u")).balance).toBe("150");
      expect((await client.plan("u")).allowance).toEqual({
        total: "100",
        remaining: "100",
        expires_at: "2026-03-01T00:00:00.000Z",
      });
      const expiry = await client.history("u", { type: "expiry" });
      expect(expiry.data.map((e) => [e.type, e.credits])).toEqual([
        ["expiry", "-70"],
      ]);
    });

    test("plan changes refuse an unknown or free plan before anything else", async () => {
      const { client } = await world({ plans: PLANS });
      expect(await code(client.changePlan("u", "nope"))).toBe(
        "422 unsupported_plan",
      );
      expect(await code(client.changePlan("u", "free"))).toBe(
        "422 free_plan_not_subscribable",
      );
    });

    // ---- the meter (ADR-0016) ----
    test("the catalog names the meter; a changed meter refuses usage of the old version and records nothing", async () => {
      const { billing, client } = await world({ metric: "voice_ms" });
      expect((await client.catalog()).config).toEqual({
        version: "v1",
        metric: "voice_ms",
        credits_per_unit: "1",
      });
      await billing.grant("u", "10000");
      expect(
        await client.reportUsage("u", {
          event_id: "s:1",
          units: "1500",
          meter_version: "v1",
        }),
      ).toMatchObject({ credits: "1500", meter_version: "v1" });
      await billing.setMeter({
        metric: "voice_seconds",
        credits_per_unit: "1",
      });
      // The same meter again changes nothing.
      await billing.setMeter({
        metric: "voice_seconds",
        credits_per_unit: "1",
      });
      const { config } = await client.catalog();
      expect(config).toEqual({
        version: "m2",
        metric: "voice_seconds",
        credits_per_unit: "1",
      });
      expect(
        await code(
          client.reportUsage("u", {
            event_id: "s:2",
            units: "2000",
            meter_version: "v1",
          }),
        ),
      ).toBe("409 meter_changed");
      expect((await client.balance("u")).balance).toBe("8500");
      // Converted, under the same event_id.
      expect(
        await client.reportUsage("u", {
          event_id: "s:2",
          units: "2",
          meter_version: "m2",
        }),
      ).toMatchObject({ credits: "2", balance: "8498", meter_version: "m2" });
      // A replay answers the first result, whatever version it names.
      expect(
        await client.reportUsage("u", {
          event_id: "s:1",
          units: "1500",
          meter_version: "m2",
        }),
      ).toMatchObject({ credits: "1500" });
    });

    test("createMeter hands what it could not report to onMeterChanged when the meter changes", async () => {
      const { billing, client } = await world({ metric: "voice_ms" });
      await billing.grant("u", "100000");
      const handed: bigint[] = [];
      const meter = createMeter(client, {
        customer: "u",
        eventPrefix: "m",
        intervalMs: 60_000,
        meterVersion: "v1",
        onMeterChanged: (units) => handed.push(units),
      });
      meter.add(1000);
      await meter.flush();
      await billing.setMeter({
        metric: "voice_seconds",
        credits_per_unit: "1",
      });
      meter.add(1500);
      await meter.flush();
      meter.add(700);
      await meter.close();
      // Units added after the change go the same way.
      expect(handed).toEqual([1500n, 700n]);
      expect((await client.balance("u")).balance).toBe("99000");
    });
  });
}
