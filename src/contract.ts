// 公开接口的契约测试。同一套测试在本仓库对内存假服务跑，在 Billing 仓库对
// 真服务跑；两边都通过，才说明假服务的行为与生产一致。用 bun:test。
import { afterEach, describe, expect, test } from "bun:test";
import {
  BillingError,
  chargedRun,
  createBillingClient,
  type ChargeStore,
  type Measurement,
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
      // 原始请求，用来检查 SDK 不会发出的请求形状
      const raw = async (
        method: string,
        path: string,
        body?: unknown,
        headers: Record<string, string> = {},
      ) => {
        const response = await billing.fetch(
          new URL(path, billing.config.baseUrl),
          {
            method,
            headers: {
              authorization: `Bearer ${billing.config.apiKey}`,
              ...(body === undefined
                ? {}
                : { "content-type": "application/json" }),
              ...headers,
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
    const slice = (slice_id = "1", max_units = "10", task_id = "t") => ({
      task_id,
      slice_id,
      metric: "units",
      max_units,
    });

    test("a wrong product key is 401 unauthorized", async () => {
      const { billing } = await world();
      const client = createBillingClient({
        ...billing.config,
        apiKey: "wrong",
        fetch: billing.fetch,
      });
      expect(await code(client.catalog())).toBe("401 unauthorized");
    });

    test("catalog carries the metering contract and the offers on sale", async () => {
      const { client } = await world({
        config: { rate_numerator: "3", rate_denominator: "2" },
        offers: [
          { sku: "small", amount: "500", currency: "usd", credits: "50" },
          { sku: "large", amount: "2000", currency: "usd", credits: "250" },
        ],
      });
      const catalog = await client.catalog();
      expect(catalog.config).toMatchObject({
        metric: "units",
        rate_numerator: "3",
        rate_denominator: "2",
        max_slice_units: "10000",
        reservation_ttl_ms: 60000,
      });
      expect(
        catalog.offers.map(({ sku, amount, currency, credits }) => ({
          sku,
          amount,
          currency,
          credits,
        })),
      ).toEqual([
        { sku: "small", amount: "500", currency: "usd", credits: "50" },
        { sku: "large", amount: "2000", currency: "usd", credits: "250" },
      ]);
      expect(catalog.offers[0]).toMatchObject({ amount_decimals: 2 });
      expect(typeof catalog.offers[0]!.offer_version).toBe("string");
      expect(catalog.payment_methods).toEqual(["card"]);
      expect(catalog.environment).toBe("test");
    });

    test("balance is zero for an unknown user and counts granted credits", async () => {
      const { billing, client } = await world();
      expect(await client.balance("u")).toMatchObject({
        account_state: "absent",
        available: "0",
        held: "0",
        spent: "0",
      });
      billing.grant("u", "100");
      expect(await client.balance("u")).toMatchObject({
        account_state: "active",
        available: "100",
        held: "0",
      });
    });

    test("a reservation holds the rate-priced maximum, rounded up", async () => {
      const { billing, client } = await world({
        config: { rate_numerator: "3", rate_denominator: "2" },
      });
      billing.grant("u", "100");
      const before = Date.now();
      const receipt = await client.reserve("u", slice("1", "5"), "k1");
      expect(receipt.held_credits).toBe("8");
      expect(receipt.current).toMatchObject({
        reservation_id: receipt.reservation_id,
        state: "held",
        needs_review: false,
        task_id: "t",
        slice_id: "1",
        metric: "units",
        max_units: "5",
        held_credits: "8",
        work_until: receipt.work_until,
        result: null,
      });
      const ttl = Date.parse(receipt.work_until) - before;
      expect(ttl).toBeGreaterThanOrEqual(59_000);
      expect(ttl).toBeLessThanOrEqual(61_000);
      expect(await client.balance("u")).toMatchObject({
        available: "92",
        held: "8",
      });
    });

    test("an idempotency key replays its result and refuses other input", async () => {
      const { billing, client } = await world();
      billing.grant("u", "100");
      const first = await client.reserve("u", slice(), "k1");
      const again = await client.reserve("u", slice(), "k1");
      expect(again.reservation_id).toBe(first.reservation_id);
      expect(await code(client.reserve("u", slice("1", "11"), "k1"))).toBe(
        "409 idempotency_conflict",
      );
      // 同一 (task, slice) 换键：同参数拿回原冻结，不同参数拒绝
      expect((await client.reserve("u", slice(), "k2")).reservation_id).toBe(
        first.reservation_id,
      );
      expect(await code(client.reserve("u", slice("1", "12"), "k3"))).toBe(
        "409 slice_conflict",
      );
      expect((await client.balance("u")).held).toBe("10");
      // 别的用户用同一个键
      billing.grant("v", "100");
      expect(await code(client.reserve("v", slice(), "k1"))).toBe(
        "404 not_found",
      );
    });

    test("a refused request does not take its key", async () => {
      const { billing, client } = await world();
      expect(await code(client.reserve("u", slice(), "k1"))).toBe(
        "422 insufficient_credits",
      );
      billing.grant("u", "100");
      expect(await code(client.reserve("u", slice(), "k1"))).toBe("accepted");
    });

    test("reservations refuse what the metering contract does not allow", async () => {
      const { billing, client, raw } = await world({
        config: { max_slice_units: "50" },
      });
      billing.grant("u", "1000");
      expect(
        await code(client.reserve("u", { ...slice(), metric: "seconds" }, "a")),
      ).toBe("422 unsupported_metric_or_slice");
      expect(await code(client.reserve("u", slice("1", "51"), "b"))).toBe(
        "422 unsupported_metric_or_slice",
      );
      const post = (body: unknown, key?: string) =>
        raw(
          "POST",
          "/v1/customers/u/reservations",
          body,
          key === undefined ? {} : { "idempotency-key": key },
        );
      expect((await post({ ...slice(), max_units: 10 }, "c")).body.code).toBe(
        "invalid_integer",
      );
      expect((await post({ ...slice(), max_units: "0" }, "d")).body.code).toBe(
        "invalid_integer",
      );
      expect((await post({ ...slice(), extra: 1 }, "e")).body.code).toBe(
        "unexpected_field",
      );
      const missing = await post(slice());
      expect(missing.status).toBe(422);
      expect(missing.body).toMatchObject({
        code: "invalid_identifier",
        retryable: false,
      });
      expect(typeof missing.body.request_id).toBe("string");
    });

    test("settling charges actual usage and returns the rest", async () => {
      const { billing, client } = await world();
      billing.grant("u", "100");
      const r = await client.reserve("u", slice("1", "10"), "k1");
      const now = new Date().toISOString();
      const usage = {
        actual_units: "3",
        started_at: now,
        ended_at: now,
        result_ref: "run-1",
      };
      expect(
        await client.settle("u", r.reservation_id, usage, "s1"),
      ).toMatchObject({
        reservation_id: r.reservation_id,
        state: "settled",
        consumed_credits: "3",
        released_credits: "7",
        reversed_credits: "0",
      });
      expect(await client.balance("u")).toMatchObject({
        available: "97",
        held: "0",
        spent: "3",
      });
      // 同样的结算换键重放原结果；不同的结算、事后退回都拒绝
      expect(
        await client.settle("u", r.reservation_id, usage, "s2"),
      ).toMatchObject({ consumed_credits: "3" });
      expect(
        await code(
          client.settle(
            "u",
            r.reservation_id,
            { ...usage, actual_units: "4" },
            "s3",
          ),
        ),
      ).toBe("409 reservation_terminal_conflict");
      expect(await code(client.release("u", r.reservation_id, "x", "r1"))).toBe(
        "409 reservation_terminal_conflict",
      );
      expect((await client.balance("u")).spent).toBe("3");
      expect(await client.reservation("u", r.reservation_id)).toMatchObject({
        state: "settled",
        held_credits: "0",
        result: { consumed_credits: "3" },
      });
    });

    test("settling refuses usage above the maximum or outside the authorization", async () => {
      const { billing, client } = await world();
      billing.grant("u", "100");
      const r = await client.reserve("u", slice("1", "10"), "k1");
      const now = new Date().toISOString(),
        later = new Date(Date.now() + 5_000).toISOString(),
        earlier = new Date(Date.now() - 600_000).toISOString();
      const settle = (
        usage: Partial<Parameters<typeof client.settle>[2]>,
        key: string,
      ) =>
        code(
          client.settle(
            "u",
            r.reservation_id,
            {
              actual_units: "1",
              started_at: now,
              ended_at: now,
              result_ref: "x",
              ...usage,
            },
            key,
          ),
        );
      expect(await settle({ actual_units: "11" }, "a")).toBe(
        "422 usage_exceeds_reservation",
      );
      expect(await settle({ ended_at: later }, "b")).toBe(
        "422 usage_outside_authorization",
      );
      expect(await settle({ started_at: earlier }, "c")).toBe(
        "422 usage_outside_authorization",
      );
      expect(await settle({ started_at: "2026-01-01T00:00:00Z" }, "d")).toBe(
        "422 invalid_interval",
      );
      expect(await settle({}, "e")).toBe("accepted");
    });

    test("release returns the whole hold and needs the unconsumed confirmation", async () => {
      const { billing, client, raw } = await world();
      billing.grant("u", "100");
      const r = await client.reserve("u", slice("1", "10"), "k1");
      const unconfirmed = await raw(
        "POST",
        `/v1/customers/u/reservations/${r.reservation_id}/release`,
        { reason: "x" },
        { "idempotency-key": "r0" },
      );
      expect(unconfirmed.body.code).toBe("consumption_confirmation_required");
      expect(
        await client.release("u", r.reservation_id, "never_executed", "r1"),
      ).toMatchObject({
        state: "released",
        consumed_credits: "0",
        released_credits: "10",
      });
      expect(await client.balance("u")).toMatchObject({
        available: "100",
        held: "0",
      });
    });

    test("an overdue hold is marked needs_review", async () => {
      let time = Date.now();
      const { billing, client } = await world({ now: () => time });
      billing.grant("u", "100");
      const r = await client.reserve("u", slice(), "k1");
      time += 61_000;
      expect(await client.reservation("u", r.reservation_id)).toMatchObject({
        state: "held",
        needs_review: true,
      });
      time += 1_000;
      expect(
        (await client.reserve("u", slice(), "k1")).current.needs_review,
      ).toBe(true);
    });

    test("reservations are private to their user", async () => {
      const { billing, client } = await world();
      billing.grant("u", "100");
      const r = await client.reserve("u", slice(), "k1");
      expect(await code(client.reservation("v", r.reservation_id))).toBe(
        "404 not_found",
      );
      expect(await code(client.reservation("u", "res_missing"))).toBe(
        "404 not_found",
      );
    });

    test("a checkout issues credits only after the payment completes", async () => {
      const { billing, client } = await world();
      const receipt = await client.checkout(
        "u",
        { sku: "credits-1000", purchase_ref: "p1" },
        "c1",
      );
      expect(receipt).toMatchObject({ state: "pending" });
      expect(receipt.order_id).toStartWith("order_");
      const order = await client.order("u", receipt.order_id);
      expect(order).toMatchObject({
        id: receipt.order_id,
        user_id: "u",
        purchase_ref: "p1",
        sku: "credits-1000",
        amount: "1000",
        currency: "usd",
        credits: "1000",
        state: "awaiting_payment",
        exception: null,
        fulfilled_at: null,
      });
      expect(order.checkout_url).toStartWith("https://");
      expect((await client.balance("u")).available).toBe("0");
      await billing.pay(receipt.order_id);
      expect(await client.order("u", receipt.order_id)).toMatchObject({
        state: "fulfilled",
      });
      expect((await client.balance("u")).available).toBe("1000");
      expect(await code(client.order("v", receipt.order_id))).toBe(
        "404 not_found",
      );
    });

    test("a purchase_ref is one purchase across keys", async () => {
      const { client } = await world({
        offers: [
          { sku: "a", amount: "500", currency: "usd", credits: "50" },
          { sku: "b", amount: "900", currency: "usd", credits: "100" },
        ],
      });
      const first = await client.checkout(
        "u",
        { sku: "a", purchase_ref: "p" },
        "c1",
      );
      expect(
        (await client.checkout("u", { sku: "a", purchase_ref: "p" }, "c2"))
          .order_id,
      ).toBe(first.order_id);
      expect(
        await code(client.checkout("u", { sku: "b", purchase_ref: "p" }, "c3")),
      ).toBe("422 unsupported_sku");
      expect(
        await code(client.checkout("u", { sku: "b", purchase_ref: "q" }, "c1")),
      ).toBe("409 idempotency_conflict");
      const second = await client.checkout(
        "u",
        { sku: "b", purchase_ref: "q" },
        "c4",
      );
      expect((await client.orders("u")).data.map((order) => order.id)).toEqual([
        second.order_id,
        first.order_id,
      ]);
    });

    test("checkout refuses unknown offers, stale quotes and unconfigured returns", async () => {
      const { client, raw } = await world();
      expect(
        await code(
          client.checkout("u", { sku: "nope", purchase_ref: "p1" }, "a"),
        ),
      ).toBe("422 unsupported_sku");
      expect(
        await code(
          client.checkout(
            "u",
            { sku: "credits-1000", purchase_ref: "p2", return_path: "/done" },
            "b",
          ),
        ),
      ).toBe("422 return_origin_not_configured");
      const stale = await raw(
        "POST",
        "/v1/customers/u/checkouts",
        { sku: "credits-1000", purchase_ref: "p3", offer_version: "old" },
        { "idempotency-key": "c" },
      );
      expect(stale).toEqual({
        status: 202,
        body: { state: "rejected", reason: "offer_changed" },
      });
      const { offers } = await client.catalog();
      const current = await raw(
        "POST",
        "/v1/customers/u/checkouts",
        {
          sku: "credits-1000",
          purchase_ref: "p4",
          offer_version: offers[0]!.offer_version,
        },
        { "idempotency-key": "d" },
      );
      expect(current.body).toMatchObject({ state: "pending" });
      expect((await client.orders("u")).data).toHaveLength(1);
    });

    test("with nothing on sale, checkout refuses every sku", async () => {
      const { client } = await world({ offers: [] });
      expect((await client.catalog()).offers).toEqual([]);
      expect(
        await code(
          client.checkout("u", { sku: "credits-1000", purchase_ref: "p" }, "a"),
        ),
      ).toBe("422 unsupported_sku");
    });

    test("a top-up session is a 30-minute link to the hosted page", async () => {
      const { client, billing } = await world({
        returnOrigin: "https://product.test",
      });
      const before = Date.now();
      const session = await client.createTopupSession(
        "u",
        { return_path: "/billing/done" },
        "t1",
      );
      expect(session.user_id).toBe("u");
      expect(session.session_id).toStartWith("topup_");
      expect(session.url).toBe(
        `${billing.config.baseUrl}/topup/${session.session_id}`,
      );
      const ttl = Date.parse(session.expires_at) - before;
      expect(ttl).toBeGreaterThanOrEqual(1_799_000);
      expect(ttl).toBeLessThanOrEqual(1_801_000);
      expect(
        (
          await client.createTopupSession(
            "u",
            { return_path: "/billing/done" },
            "t1",
          )
        ).session_id,
      ).toBe(session.session_id);
      expect(await code(client.createTopupSession("u", {}, "t1"))).toBe(
        "409 idempotency_conflict",
      );
      const plain = await world();
      expect(
        await code(
          plain.client.createTopupSession("u", { return_path: "/x" }, "t2"),
        ),
      ).toBe("422 return_origin_not_configured");
    });

    test("chargedRun settles once, survives replay and stops without credits", async () => {
      const { billing, client } = await world();
      billing.grant("u", "100");
      const store = memoryChargeStore(),
        input = {
          user: "u",
          task_id: "t",
          slice_id: "1",
          metric: "units",
          max_units: "60",
        };
      let runs = 0;
      const execute = async () => ({
        units: String(++runs * 37),
        result: "ok",
      });
      expect(await chargedRun(client, store, input, execute)).toEqual({
        status: "done",
        result: "ok",
      });
      expect(await chargedRun(client, store, input, execute)).toEqual({
        status: "finished",
        outcome: "settled",
      });
      expect(runs).toBe(1);
      expect((await client.balance("u")).available).toBe("63");
      expect(
        await chargedRun(
          client,
          store,
          { ...input, task_id: "t2", max_units: "100" },
          execute,
        ),
      ).toEqual({ status: "stopped", reason: "insufficient_credits" });
      expect(runs).toBe(1);
    });
  });
}

/** 测试用的内存 ChargeStore；生产里换成自己数据库的事务 */
export function memoryChargeStore(): ChargeStore {
  type Row = {
    reservation_id?: string;
    claimed?: boolean;
    measurement?: Measurement;
    outcome?: "settled" | "not_charged";
  };
  const rows = new Map<string, Row>();
  const row = (task: string, slice: string) => rows.get(`${task}:${slice}`)!;
  return {
    async begin(record) {
      const key = `${record.task_id}:${record.slice_id}`;
      if (!rows.has(key)) rows.set(key, {});
      return { ...rows.get(key)! };
    },
    async saveReservation(task, slice, id) {
      row(task, slice).reservation_id = id;
    },
    async claim(task, slice) {
      if (row(task, slice).claimed) return false;
      return (row(task, slice).claimed = true);
    },
    async saveMeasurement(task, slice, measurement) {
      row(task, slice).measurement = measurement;
    },
    async finish(task, slice, outcome) {
      row(task, slice).outcome = outcome;
    },
  };
}
