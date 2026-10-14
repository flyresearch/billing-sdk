// 产品测试用的内存 Billing。它按公开接口（API v1）的规则行为，不含 Billing
// 服务端代码：额度不足、同一个幂等键配了不同参数、结算超出冻结上限或授权期，
// 都会像生产一样被拒绝，产品的测试因此能因为真实的原因失败。
//
// 它与真服务的一致性由 ./contract.ts 的契约测试保证：同一套测试在这里对它跑，
// 在 Billing 仓库里对真服务跑。它不证明部署可用，也不覆盖管理端、退款、
// 自定金额（flexible）额度包和账户关闭。
//
//   const billing = await createTestBilling();
//   const client = createBillingClient({ ...billing.config, fetch: billing.fetch });
//   billing.grant("user_1", "1000");

export interface TestBillingOptions {
  /** 计量合同；默认 metric units、1 单位 1 额度、单次上限 10000、冻结 60 秒 */
  config?: {
    metric?: string;
    rate_numerator?: string;
    rate_denominator?: string;
    max_slice_units?: string;
    reservation_ttl_ms?: number;
  };
  /** 在售的固定额度包；默认一档。传空数组表示不卖任何档位 */
  offers?: {
    sku: string;
    amount: string;
    currency: string;
    credits: string;
  }[];
  /** 付款后回到产品的站点；配置后 checkout 和充值链接才接受 return_path */
  returnOrigin?: string;
  /** 服务端时钟，默认 Date.now；测试冻结过期时传入可控时钟 */
  now?: () => number;
}

/** createTestBilling 的返回值；Billing 仓库里的真服务实现同一个接口 */
export interface TestBilling {
  /** 交给 SDK：`{ ...billing.config, fetch: billing.fetch }` */
  config: { baseUrl: string; apiKey: string };
  /** 代替网络回答 SDK 的请求 */
  fetch: typeof fetch;
  /** 给用户发测试额度，相当于控制台的测试赠额 */
  grant(user: string, credits: string): void;
  /** 让订单付款完成，相当于 Stripe 回调 */
  pay(orderId: string): Promise<void>;
  close(): void;
}

export type CreateTestBilling = (
  options?: TestBillingOptions,
) => Promise<TestBilling>;

const ORIGIN = "http://billing.test";
const MAX_INT64 = 9223372036854775807n;

class Refusal extends Error {
  constructor(
    readonly code: string,
    readonly status = 422,
  ) {
    super(code);
  }
}
function must(condition: unknown, code: string, status = 422): void {
  if (!condition) throw new Refusal(code, status);
}
function units(value: unknown, positive = false): bigint {
  must(
    typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value),
    "invalid_integer",
  );
  const result = BigInt(value as string);
  must(result <= MAX_INT64 && (!positive || result > 0n), "invalid_integer");
  return result;
}
function textId(value: unknown): string {
  must(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 200 &&
      !/[\u0000-\u001f\u007f]/.test(value),
    "invalid_identifier",
  );
  return value as string;
}
function record(value: unknown): Record<string, unknown> {
  must(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "invalid_body",
  );
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  must(
    Object.keys(value).every((key) => allowed.includes(key)),
    "unexpected_field",
  );
}
function returnPath(value: unknown): string {
  must(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 512 &&
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !value.includes("\\") &&
      !value.includes("#"),
    "invalid_return_path",
  );
  return value as string;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
    .join(",")}}`;
}
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
// 额度按费率向上取整
const price = (quantity: bigint, numerator: string, denominator: string) =>
  (quantity * BigInt(numerator) + BigInt(denominator) - 1n) /
  BigInt(denominator);
const ZERO_DECIMAL = new Set(
  "bif clp djf gnf jpy kmf krw mga pyg rwf ugx vnd vuv xaf xof xpf".split(" "),
);
const THREE_DECIMAL = new Set("bhd jod kwd omr tnd".split(" "));
const decimals = (currency: string) =>
  ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2;

type Body = Record<string, unknown>;
interface Source {
  source_key: string;
  kind: "test_grant" | "purchase";
  total: bigint;
  available: bigint;
  held: bigint;
  spent: bigint;
}
interface Reservation {
  id: string;
  user: string;
  task_id: string;
  slice_id: string;
  request: string;
  metric: string;
  max_units: bigint;
  held: bigint;
  rate_version: string;
  created_at: string;
  work_until: string;
  state: "held" | "settled" | "released";
  needs_review: boolean;
  receipt: Body;
  allocations: { source: Source; amount: bigint }[];
  terminal_request?: string;
  result?: Body;
}
interface Order {
  id: string;
  user_id: string;
  purchase_ref: string;
  sku: string;
  amount: string;
  currency: string;
  credits: string;
  state: "awaiting_payment" | "fulfilled";
  payment_intent: string | null;
  created_at: string;
  fulfilled_at: string | null;
}

export const createTestBilling: CreateTestBilling = async (options = {}) => {
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const productId = newId("prod"),
    accountIds = new Map<string, string>();
  const apiKey = `test_${crypto.randomUUID()}`;
  const config = {
    version: "v1",
    metric: "units",
    rate_numerator: "1",
    rate_denominator: "1",
    max_slice_units: "10000",
    reservation_ttl_ms: 60_000,
    ...options.config,
  };
  const offers = (
    options.offers ?? [
      { sku: "credits-1000", amount: "1000", currency: "usd", credits: "1000" },
    ]
  ).map((offer, i) => ({
    ...offer,
    price_id: `price_test_${offer.sku}`,
    offer_version: `test-v${i + 1}`,
  }));
  const sources = new Map<string, Source[]>();
  const reservations = new Map<string, Reservation>();
  const orders: Order[] = [];
  // 账务（冻结/结算/退回）与收款（下单/充值链接）的幂等键各自独立
  const ledgerKeys = new Map<
    string,
    { user: string; request: string; status: number; body: Body }
  >();
  const paymentKeys = new Map<string, { request: string; result: Body }>();

  const account = (user: string) => {
    if (!accountIds.has(user)) accountIds.set(user, newId("acct"));
    if (!sources.has(user)) sources.set(user, []);
    return sources.get(user)!;
  };
  const fund = (
    user: string,
    source_key: string,
    credits: bigint,
    kind: Source["kind"],
  ) => {
    account(user).push({
      source_key,
      kind,
      total: credits,
      available: credits,
      held: 0n,
      spent: 0n,
    });
  };

  function balance(user: string): Body {
    const list = sources.get(user);
    const sum = (field: "available" | "held" | "spent") =>
      String((list ?? []).reduce((total, s) => total + s[field], 0n));
    return {
      account_state: list ? "active" : "absent",
      available: sum("available"),
      held: sum("held"),
      spent: sum("spent"),
      reversed: "0",
      expired: "0",
      restricted_credits: "0",
      sources: (list ?? []).map((s) => ({
        source_key: s.source_key,
        kind: s.kind,
        total: String(s.total),
        available: String(s.available),
        restricted_credits: "0",
        held: String(s.held),
        spent: String(s.spent),
        reversed: "0",
        restricted: false,
        loss_credits: "0",
      })),
    };
  }

  function reservationView(user: string, id: string): Body {
    textId(id);
    const row = reservations.get(id);
    must(row && row.user === user, "not_found", 404);
    if (row!.state === "held" && row!.work_until <= iso())
      row!.needs_review = true;
    return {
      reservation_id: row!.id,
      state: row!.state,
      needs_review: row!.needs_review,
      task_id: row!.task_id,
      slice_id: row!.slice_id,
      metric: row!.metric,
      max_units: String(row!.max_units),
      held_credits: row!.state === "held" ? String(row!.held) : "0",
      work_until: row!.work_until,
      rate_version: row!.rate_version,
      result: row!.result ?? null,
    };
  }

  // 账务写操作：键绑定 (路由, 用户, 参数)，重放返回原结果，失败的请求不占用键
  function write(
    user: string,
    key: string | null,
    route: string,
    payload: Body,
    work: () => { status: number; body: Body },
  ) {
    textId(key);
    const request = canonical({ route, user, payload });
    const old = ledgerKeys.get(key!);
    if (old) {
      must(old.user === user, "not_found", 404);
      must(old.request === request, "idempotency_conflict", 409);
      return { status: old.status, body: old.body };
    }
    const reply = work();
    ledgerKeys.set(key!, { user, request, ...reply });
    return reply;
  }

  function reserve(user: string, key: string | null, value: unknown) {
    const input = record(value);
    fields(input, [
      "task_id",
      "slice_id",
      "metric",
      "max_units",
      "credits_limit",
    ]);
    const task = textId(input.task_id),
      slice = textId(input.slice_id),
      metric = textId(input.metric);
    const max = units(input.max_units, true);
    const limit =
      input.credits_limit === undefined
        ? null
        : units(input.credits_limit, true);
    const reply = write(user, key, "reservation.create", input, () => {
      const request = canonical(input);
      const old = [...reservations.values()].find(
        (r) => r.user === user && r.task_id === task && r.slice_id === slice,
      );
      // 同一 (task, slice) 换了键也不会产生第二笔冻结
      if (old) {
        must(old.request === request, "slice_conflict", 409);
        return { status: 201, body: old.receipt };
      }
      must(
        metric === config.metric && max <= BigInt(config.max_slice_units),
        "unsupported_metric_or_slice",
      );
      const cost = price(max, config.rate_numerator, config.rate_denominator);
      must(limit === null || cost <= limit, "credits_limit_exceeded");
      // 测试赠额先用，其次按发放先后
      const usable = [...(sources.get(user) ?? [])]
        .filter((s) => s.available > 0n)
        .sort(
          (a, b) =>
            Number(a.kind !== "test_grant") - Number(b.kind !== "test_grant"),
        );
      must(
        usable.reduce((sum, s) => sum + s.available, 0n) >= cost,
        "insufficient_credits",
      );
      const id = newId("res"),
        createdAt = iso(),
        until = new Date(now() + config.reservation_ttl_ms).toISOString();
      const allocations: Reservation["allocations"] = [];
      let remaining = cost;
      for (const source of usable) {
        if (remaining === 0n) break;
        const amount =
          source.available < remaining ? source.available : remaining;
        source.available -= amount;
        source.held += amount;
        allocations.push({ source, amount });
        remaining -= amount;
      }
      const receipt = {
        reservation_id: id,
        held_credits: String(cost),
        work_until: until,
        rate_version: config.version,
        operation_id: newId("op"),
      };
      reservations.set(id, {
        id,
        user,
        task_id: task,
        slice_id: slice,
        request,
        metric,
        max_units: max,
        held: cost,
        rate_version: config.version,
        created_at: createdAt,
        work_until: until,
        state: "held",
        needs_review: false,
        receipt,
        allocations,
      });
      return { status: 201, body: receipt };
    });
    // 回执原样重放，current 每次当场读
    const id = reply.body.reservation_id as string;
    return {
      ...reply,
      body: { ...reply.body, current: reservationView(user, id) },
    };
  }

  function finish(
    user: string,
    id: string,
    key: string | null,
    action: "settle" | "release",
    value: unknown,
  ) {
    textId(id);
    const input = record(value);
    if (action === "settle") {
      fields(input, ["actual_units", "started_at", "ended_at", "result_ref"]);
      units(input.actual_units);
      textId(input.result_ref);
      for (const name of ["started_at", "ended_at"]) {
        const date = input[name];
        must(
          typeof date === "string" &&
            Number.isFinite(Date.parse(date)) &&
            new Date(date).toISOString() === date,
          "invalid_interval",
        );
      }
    } else {
      fields(input, ["reason", "confirmed_unconsumed"]);
      textId(input.reason);
      must(
        input.confirmed_unconsumed === true,
        "consumption_confirmation_required",
      );
    }
    return write(user, key, `reservation.${action}:${id}`, input, () => {
      const row = reservations.get(id);
      must(row && row.user === user, "not_found", 404);
      const request = canonical({ action, input });
      if (row!.state !== "held") {
        must(
          row!.terminal_request === request,
          "reservation_terminal_conflict",
          409,
        );
        return { status: 200, body: row!.result! };
      }
      let consumed = 0n;
      if (action === "settle") {
        const actual = units(input.actual_units);
        must(actual <= row!.max_units, "usage_exceeds_reservation");
        const start = input.started_at as string,
          end = input.ended_at as string;
        must(
          row!.created_at <= start &&
            start <= end &&
            end <= row!.work_until &&
            end <= iso(),
          "usage_outside_authorization",
        );
        consumed = price(
          actual,
          config.rate_numerator,
          config.rate_denominator,
        );
      }
      let remaining = consumed,
        released = 0n;
      for (const { source, amount } of row!.allocations) {
        const spent = remaining < amount ? remaining : amount;
        source.held -= amount;
        source.spent += spent;
        source.available += amount - spent;
        released += amount - spent;
        remaining -= spent;
      }
      const body = {
        reservation_id: id,
        state: action === "settle" ? "settled" : "released",
        consumed_credits: String(consumed),
        released_credits: String(released),
        expired_credits: "0",
        reversed_credits: "0",
        operation_id: newId("op"),
      };
      Object.assign(row!, {
        state: body.state,
        needs_review: false,
        result: body,
        terminal_request: request,
      });
      return { status: 200, body };
    });
  }

  function orderView(order: Order): Body {
    return {
      id: order.id,
      product_id: productId,
      account_id: accountIds.get(order.user_id),
      user_id: order.user_id,
      purchase_ref: order.purchase_ref,
      sku: order.sku,
      price_id: `price_test_${order.sku}`,
      amount: order.amount,
      currency: order.currency,
      credits: order.credits,
      state: order.state,
      session_id: `cs_test_${order.id}`,
      checkout_url: `https://checkout.test/${order.id}`,
      payment_intent: order.payment_intent,
      exception: null,
      created_at: order.created_at,
      fulfilled_at: order.fulfilled_at,
      offer_kind: "fixed",
      payment_method: null,
    };
  }

  // 收款写操作的幂等键：同键同参数重放，同键不同参数拒绝
  function payment(
    key: string | null,
    request: string,
    work: () => Body,
  ): Body {
    textId(key);
    const old = paymentKeys.get(key!);
    if (old) {
      must(old.request === request, "idempotency_conflict", 409);
      return old.result;
    }
    const result = work();
    paymentKeys.set(key!, { request, result });
    return result;
  }

  function checkout(user: string, key: string | null, value: unknown): Body {
    const raw = record(value);
    fields(raw, [
      "offer_version",
      "purchase_ref",
      "sku",
      "return_path",
      "amount",
      "payment_method",
    ]);
    const { offer_version, ...input } = raw;
    if (offer_version !== undefined) textId(offer_version);
    const ref = textId(input.purchase_ref);
    if (input.payment_method !== undefined)
      must(
        textId(input.payment_method) === "card",
        "unsupported_payment_method",
      );
    if (input.return_path !== undefined) returnPath(input.return_path);
    must(
      input.return_path === undefined || options.returnOrigin,
      "return_origin_not_configured",
    );
    const transport = canonical({
      user,
      input,
      ...(offer_version === undefined
        ? {}
        : { quote: { version: offer_version } }),
    });
    textId(key);
    const old = paymentKeys.get(key!);
    if (old) {
      must(old.request === transport, "idempotency_conflict", 409);
      return old.result;
    }
    // 同一 purchase_ref 是同一笔购买：换键重试拿回原订单
    const previous = orders.find(
      (o) => o.user_id === user && o.purchase_ref === ref,
    );
    if (previous) must(input.sku === previous.sku, "unsupported_sku");
    if (!previous && offer_version !== undefined) {
      const current = offers.find((o) => o.sku === input.sku);
      if (!current || current.offer_version !== offer_version) {
        const result = { state: "rejected", reason: "offer_changed" };
        paymentKeys.set(key!, { request: transport, result });
        return result;
      }
    }
    let order = previous;
    if (!order) {
      const offer = offers.find((o) => o.sku === textId(input.sku));
      must(offer, "unsupported_sku");
      must(input.amount === undefined, "amount_not_accepted");
      account(user);
      order = {
        id: newId("order"),
        user_id: user,
        purchase_ref: ref,
        sku: offer!.sku,
        amount: offer!.amount,
        currency: offer!.currency,
        credits: offer!.credits,
        state: "awaiting_payment",
        payment_intent: null,
        created_at: iso(),
        fulfilled_at: null,
      };
      orders.push(order);
    }
    const result = {
      order_id: order.id,
      operation_id: `payop_${order.id.slice(6)}`,
      state: "pending",
    };
    paymentKeys.set(key!, { request: transport, result });
    return result;
  }

  function topupSession(
    user: string,
    key: string | null,
    value: unknown,
  ): Body {
    textId(user);
    const input = record(value);
    fields(input, ["return_path"]);
    if (input.return_path !== undefined) returnPath(input.return_path);
    must(
      input.return_path === undefined || options.returnOrigin,
      "return_origin_not_configured",
    );
    const result = payment(
      key,
      canonical({ route: "topup.session", user, input }),
      () => ({
        session_id: newId("topup"),
        user_id: user,
        expires_at: new Date(now() + 1_800_000).toISOString(),
      }),
    );
    return { ...result, url: `${ORIGIN}/topup/${result.session_id}` };
  }

  function route(
    method: string,
    parts: string[],
    key: string | null,
    body: () => unknown,
  ) {
    const ok = (b: Body, status = 200) => ({ status, body: b });
    if (method === "GET" && parts.join("/") === "v1/capabilities")
      return ok({
        version: "v1",
        release_version: "test",
        environment: "test",
        server_time: iso(),
        management_actions: [],
        actions: [
          "catalog.read",
          "account.read",
          "account.close",
          "balance.read",
          "reservation.create",
          "reservation.read",
          "reservation.settle",
          "reservation.release",
          "operation.read",
          "purchase_policy.read",
          "purchase_policy.update",
          "topup_session.revoke",
          "orders.read",
          "ledger.read",
          "checkout.create",
        ],
        product_id: productId,
      });
    if (method === "GET" && parts.join("/") === "v1/catalog")
      return ok({
        config,
        offers: offers.map((o) => ({
          ...o,
          amount_decimals: decimals(o.currency),
        })),
        payment_methods: ["card"],
        environment: "test",
      });
    if (parts[0] !== "v1" || parts[1] !== "customers" || !parts[2]) return null;
    const user = parts[2];
    const rest = parts.slice(3).join("/");
    if (method === "GET") {
      if (rest === "balance") return ok(balance(user));
      if (parts[3] === "reservations" && parts.length === 5)
        return ok(reservationView(user, parts[4]!));
      if (rest === "orders") {
        const data = orders
          .filter((o) => o.user_id === user)
          .reverse()
          .map(orderView);
        return ok({ data, has_more: false, next_cursor: null });
      }
      if (parts[3] === "orders" && parts.length === 5) {
        const order = orders.find(
          (o) => o.id === parts[4] && o.user_id === user,
        );
        must(order, "not_found", 404);
        return ok(orderView(order!));
      }
      return null;
    }
    if (method !== "POST") return null;
    if (rest === "reservations") return reserve(user, key, body());
    if (parts[3] === "reservations" && parts.length === 6) {
      if (parts[5] === "settle")
        return finish(user, parts[4]!, key, "settle", body());
      if (parts[5] === "release")
        return finish(user, parts[4]!, key, "release", body());
    }
    if (rest === "checkouts") return ok(checkout(user, key, body()), 202);
    if (rest === "topup-sessions")
      return ok(topupSession(user, key, body()), 201);
    return null;
  }

  const handle = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const requestId = newId("req");
    const reply = (body: unknown, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
        },
      });
    try {
      must(
        request.headers.get("authorization") === `Bearer ${apiKey}`,
        "unauthorized",
        401,
      );
      const url = new URL(request.url);
      const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
      const text = await request.text();
      const body = () => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new Refusal("invalid_json", 400);
        }
      };
      const result = route(
        request.method,
        parts,
        request.headers.get("idempotency-key"),
        body,
      );
      must(result, "not_found", 404);
      return reply(result!.body, result!.status);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return reply(
        { code: error.code, request_id: requestId, retryable: false },
        error.status,
      );
    }
  };

  return {
    config: { baseUrl: ORIGIN, apiKey },
    fetch: handle as typeof fetch,
    grant(user, credits) {
      fund(user, crypto.randomUUID(), units(credits, true), "test_grant");
    },
    async pay(orderId) {
      const order = orders.find((o) => o.id === orderId);
      if (!order || order.state !== "awaiting_payment") return;
      Object.assign(order, {
        state: "fulfilled",
        payment_intent: `pi_test_${order.id}`,
        fulfilled_at: iso(),
      });
      fund(
        order.user_id,
        `order.${order.id}`,
        BigInt(order.credits),
        "purchase",
      );
    },
    close() {},
  };
};
