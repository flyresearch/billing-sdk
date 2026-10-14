// 产品测试用的内存 Billing（API v1，ADR-0014）。按公开接口的规则行为，不含
// Billing 服务端代码：事件 ID 冲突、余额用尽、非法输入都会像生产一样返回。
// 与真服务的一致性由 ./contract.ts 的契约测试保证：同一套测试在这里对它跑，
// 在 Billing 仓库里对真服务跑。不覆盖托管充值页、Stripe 与管理端：建单得到的
// checkout_url 不能打开，付款用 payOrder() 模拟。
//
//   const billing = await createTestBilling();
//   const client = createBillingClient({ ...billing.config, fetch: billing.fetch });
//   billing.grant("user_1", "1000");

/** 测试用额度包。fixed：固定金额与额度；flexible：用户在范围内自定金额 */
export type TestOffer =
  | {
      kind?: "fixed";
      sku: string;
      currency?: string;
      amount: string;
      credits: string;
    }
  | {
      kind: "flexible";
      sku: string;
      currency?: string;
      min_amount: string;
      max_amount: string;
      step?: string;
      credits_per_unit: string;
      /** 预填金额，须在范围内 */
      amount: string;
    };

export interface TestBillingOptions {
  /** 在售额度包，按顺序；默认没有。payments 为 false 时 catalog 不列出 */
  offers?: TestOffer[];
  /** 每单位用量扣多少额度，默认 1 */
  creditsPerUnit?: number;
  /** 是否已配置收款，默认 true；false 时建充值链接返回 503 stripe_not_configured */
  payments?: boolean;
  /** 产品的回跳站点；配置后充值链接才接受 return_path */
  returnOrigin?: string;
  /** 服务端时钟，默认 Date.now */
  now?: () => number;
}

/** createTestBilling 的返回值；Billing 仓库里的真服务实现同一个接口 */
export interface TestBilling {
  /** 交给 SDK：`{ ...billing.config, fetch: billing.fetch }` */
  config: { baseUrl: string; apiKey: string };
  /** 代替网络回答 SDK 的请求 */
  fetch: typeof fetch;
  /** 给客户发测试额度（流水类型 adjustment） */
  grant(customer: string, credits: string): Promise<void>;
  /** 模拟一次已付款的充值（流水类型 purchase） */
  purchase(customer: string, credits: string): Promise<void>;
  /** 模拟 checkout 建的订单付款成功：订单 fulfilled，额度到账（先抵欠额） */
  payOrder(orderId: string): Promise<void>;
  close(): void;
}

export type CreateTestBilling = (
  options?: TestBillingOptions,
) => Promise<TestBilling>;

const ORIGIN = "https://billing.test";
const PAGE = 50;
const ORDER_PAGE = 25;
// Stripe 的金额小数位（不是展示精度）：https://docs.stripe.com/currencies#special-cases
const ZERO_DECIMAL = new Set(
  "bif clp djf gnf jpy kmf krw mga pyg rwf vnd vuv xaf xof xpf".split(" "),
);
const THREE_DECIMAL = new Set("bhd jod kwd omr tnd".split(" "));
const decimals = (currency: string) =>
  ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2;

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
/** The service's validation refusals: 422 with a code naming what was wrong. */
const invalid = (code: string, message: string): never => {
  throw new Refusal(422, code, message);
};
function id(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    invalid(
      "invalid_identifier",
      `${field} must be a string of 1-200 characters without control characters`,
    );
  return value as string;
}
function integer(value: unknown, field: string): number {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,15})$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    invalid("invalid_integer", `${field} must be a decimal integer string`);
  return Number(value);
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}
const hex = () => crypto.randomUUID().replaceAll("-", "");

interface Entry {
  seq: number;
  id: string;
  customer: string;
  type: "purchase" | "usage" | "refund" | "adjustment";
  credits: number;
  balance_after: number;
  created_at: string;
  event_id?: string;
  request?: string;
  metadata?: Record<string, string>;
  note?: string;
  order?: { id: string; amount: string; currency: string; state: string };
}

interface TestOrder {
  seq: number;
  id: string;
  customer: string;
  purchase_ref: string;
  sku: string;
  amount: string;
  currency: string;
  credits: string;
  state: "awaiting_payment" | "fulfilled";
  checkout_url: string;
  exception: null;
  created_at: string;
  fulfilled_at: string | null;
}

export const createTestBilling: CreateTestBilling = async (options = {}) => {
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const apiKey = `bk_test_${hex()}`;
  const creditsPerUnit = options.creditsPerUnit ?? 1;
  const balances = new Map<string, number>();
  const entries: Entry[] = [];
  let seq = 0;
  const payments = options.payments !== false;
  const offers = (options.offers ?? []).map((offer, i) => ({
    ...offer,
    kind: offer.kind ?? "fixed",
    currency: offer.currency ?? "usd",
    offer_version: `test-v${i + 1}`,
  }));
  const orders: TestOrder[] = [];
  const checkoutKeys = new Map<string, { request: string; result: unknown }>();
  const publicOrder = ({ seq: _, customer: __, ...order }: TestOrder) => order;

  const balanceOf = (customer: string) => balances.get(customer) ?? 0;
  const standing = (balance: number) => ({
    balance: String(balance),
    allowed: balance > 0,
  });
  function append(
    customer: string,
    type: Entry["type"],
    credits: number,
    extra: Partial<Entry> = {},
  ) {
    const balance = balanceOf(customer) + credits;
    balances.set(customer, balance);
    entries.push({
      seq: ++seq,
      id: `le_${hex()}`,
      customer,
      type,
      credits,
      balance_after: balance,
      created_at: iso(),
      ...extra,
    });
    return balance;
  }

  async function body(request: Request): Promise<Record<string, unknown>> {
    const text = await request.text();
    if (text === "") return {};
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      (() => {
        throw new Refusal(400, "invalid_json", "body is not JSON");
      })();
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
      invalid("invalid_body", "body must be a JSON object");
    return value as Record<string, unknown>;
  }

  async function route(
    request: Request,
  ): Promise<{ status: number; body: unknown }> {
    if (request.headers.get("authorization") !== `Bearer ${apiKey}`)
      throw new Refusal(
        401,
        "unauthorized",
        "the product key is invalid or revoked",
      );
    const url = new URL(request.url);
    const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
    if (request.method === "GET" && url.pathname === "/v1/catalog")
      return {
        status: 200,
        body: {
          offers: payments
            ? offers.map((offer) => ({
                ...offer,
                ...(offer.kind === "flexible"
                  ? {
                      credits: String(
                        BigInt(offer.amount) *
                          BigInt(
                            (offer as { credits_per_unit: string })
                              .credits_per_unit,
                          ),
                      ),
                    }
                  : {}),
                amount_decimals: decimals(offer.currency),
              }))
            : [],
          payment_methods: payments ? ["card"] : [],
        },
      };
    if (
      parts[0] !== "v1" ||
      parts[1] !== "customers" ||
      (parts.length !== 4 && !(parts.length === 5 && parts[3] === "orders"))
    )
      throw new Refusal(404, "not_found", "no such route");
    const customer = id(parts[2], "customer");
    if (parts.length === 5 && request.method === "GET") {
      const order = orders.find(
        (o) => o.id === parts[4] && o.customer === customer,
      );
      if (!order) throw new Refusal(404, "not_found", "no such order");
      return { status: 200, body: publicOrder(order) };
    }
    const action = `${request.method} ${parts[3]}`;
    if (action === "GET balance")
      return { status: 200, body: standing(balanceOf(customer)) };
    if (action === "POST usage") {
      const input = await body(request);
      for (const key of Object.keys(input))
        if (!["event_id", "units", "metadata"].includes(key))
          invalid("unexpected_field", `unknown field ${key}`);
      const eventId = id(input.event_id, "event_id");
      const units = integer(input.units, "units");
      const metadata = (input.metadata ?? null) as Record<
        string,
        string
      > | null;
      if (metadata !== null) {
        if (typeof metadata !== "object" || Array.isArray(metadata))
          invalid("invalid_body", "metadata must be an object of strings");
        if (Object.values(metadata).some((v) => typeof v !== "string"))
          invalid("invalid_metadata", "metadata values must be strings");
        if (new TextEncoder().encode(JSON.stringify(metadata)).length > 1024)
          invalid("invalid_metadata", "metadata must be at most 1 KB");
      }
      const request_ = canonical({ customer, units, metadata });
      const old = entries.find((e) => e.event_id === eventId);
      if (old) {
        if (old.request !== request_)
          throw new Refusal(
            409,
            "event_conflict",
            "event_id was used with different content",
          );
        return {
          status: 200,
          body: {
            event_id: eventId,
            credits: String(-old.credits),
            ...standing(balanceOf(customer)),
          },
        };
      }
      const credits = units * creditsPerUnit;
      if (!Number.isSafeInteger(credits))
        invalid("integer_overflow", "units out of range");
      const balance = append(customer, "usage", -credits, {
        event_id: eventId,
        request: request_,
        ...(metadata === null ? {} : { metadata }),
      });
      return {
        status: 200,
        body: {
          event_id: eventId,
          credits: String(credits),
          ...standing(balance),
        },
      };
    }
    if (action === "POST topup-sessions") {
      const input = await body(request);
      // The service binds a top-up request to its Idempotency-Key, as it does purchases.
      id(request.headers.get("idempotency-key"), "Idempotency-Key");
      for (const key of Object.keys(input))
        if (key !== "return_path")
          invalid("unexpected_field", `unknown field ${key}`);
      const path = input.return_path;
      if (
        path !== undefined &&
        (typeof path !== "string" ||
          path.length > 512 ||
          !path.startsWith("/") ||
          path.startsWith("//") ||
          path.includes("\\"))
      )
        invalid(
          "invalid_return_path",
          "return_path must be a path starting with /",
        );
      if (path !== undefined && !options.returnOrigin)
        invalid(
          "return_origin_not_configured",
          "return_path needs the product's return origin configured",
        );
      if (options.payments === false)
        throw new Refusal(
          503,
          "stripe_not_configured",
          "this product has no Stripe configuration",
        );
      return {
        status: 201,
        body: {
          url: `${ORIGIN}/topup/ts_${hex()}`,
          expires_at: new Date(now() + 30 * 60_000).toISOString(),
        },
      };
    }
    if (action === "POST checkouts") {
      const input = await body(request);
      if (!payments)
        throw new Refusal(
          503,
          "stripe_not_configured",
          "this product has no Stripe configuration",
        );
      for (const key of Object.keys(input))
        if (
          ![
            "offer_version",
            "purchase_ref",
            "sku",
            "return_path",
            "amount",
            "payment_method",
          ].includes(key)
        )
          invalid("unexpected_field", `unknown field ${key}`);
      const { offer_version, ...rest } = input;
      if (offer_version !== undefined) id(offer_version, "offer_version");
      const ref = id(input.purchase_ref, "purchase_ref");
      if (
        input.payment_method !== undefined &&
        id(input.payment_method, "payment_method") !== "card"
      )
        invalid(
          "unsupported_payment_method",
          "payment_method must be one the product configured",
        );
      const path = input.return_path;
      if (
        path !== undefined &&
        (typeof path !== "string" ||
          path.length < 1 ||
          path.length > 512 ||
          !path.startsWith("/") ||
          path.startsWith("//") ||
          path.includes("\\") ||
          path.includes("#"))
      )
        invalid(
          "invalid_return_path",
          "return_path must be a path starting with /",
        );
      if (path !== undefined && !options.returnOrigin)
        invalid(
          "return_origin_not_configured",
          "return_path needs the product's return origin configured",
        );
      const key = id(request.headers.get("idempotency-key"), "Idempotency-Key");
      const transport = canonical({
        customer,
        input: rest,
        ...(offer_version === undefined ? {} : { quote: offer_version }),
      });
      const replay = checkoutKeys.get(key);
      if (replay) {
        if (replay.request !== transport)
          throw new Refusal(
            409,
            "idempotency_conflict",
            "this Idempotency-Key was used with different content",
          );
        return { status: 202, body: replay.result };
      }
      const remember = (result: unknown) => {
        checkoutKeys.set(key, { request: transport, result });
        return { status: 202, body: result };
      };
      let order = orders.find(
        (o) => o.customer === customer && o.purchase_ref === ref,
      );
      if (order && input.sku !== order.sku)
        invalid("unsupported_sku", "a purchase_ref keeps its original sku");
      if (!order && offer_version !== undefined) {
        const current = offers.find((o) => o.sku === input.sku);
        if (!current || current.offer_version !== offer_version)
          return remember({ state: "rejected", reason: "offer_changed" });
      }
      if (!order) {
        const offer = offers.find((o) => o.sku === input.sku);
        if (!offer) invalid("unsupported_sku", "no such offer on sale");
        let amount: string, credits: string;
        if (offer!.kind === "flexible") {
          const flexible = offer as Extract<TestOffer, { kind: "flexible" }>;
          const value = BigInt(integer(input.amount, "amount"));
          const min = BigInt(flexible.min_amount),
            max = BigInt(flexible.max_amount),
            step = BigInt(flexible.step ?? "1");
          if (value < min || value > max || (value - min) % step !== 0n)
            invalid(
              "amount_out_of_range",
              "amount is outside the offer's range",
            );
          amount = value.toString();
          credits = (value * BigInt(flexible.credits_per_unit)).toString();
        } else {
          if (input.amount !== undefined)
            invalid("amount_not_accepted", "a fixed offer takes no amount");
          amount = offer!.amount;
          credits = (offer as { credits: string }).credits;
        }
        const orderId = `order_${hex()}`;
        order = {
          seq: ++seq,
          id: orderId,
          customer,
          purchase_ref: ref,
          sku: offer!.sku,
          amount,
          currency: offer!.currency,
          credits,
          state: "awaiting_payment",
          checkout_url: `${ORIGIN}/checkout/${orderId}`,
          exception: null,
          created_at: iso(),
          fulfilled_at: null,
        };
        orders.push(order);
      }
      return remember({
        order_id: order.id,
        operation_id: `op_${hex()}`,
        state: "pending",
      });
    }
    if (action === "GET orders") {
      const cursor = url.searchParams.get("cursor");
      const before = cursor === null ? Infinity : integer(cursor, "cursor");
      const rows = orders
        .filter((o) => o.customer === customer && o.seq < before)
        .reverse();
      const page = rows.slice(0, ORDER_PAGE);
      return {
        status: 200,
        body: {
          data: page.map(publicOrder),
          has_more: rows.length > ORDER_PAGE,
          next_cursor:
            rows.length > ORDER_PAGE
              ? String(page[page.length - 1]!.seq)
              : null,
        },
      };
    }
    if (action === "GET history") {
      const cursor = url.searchParams.get("cursor");
      const type = url.searchParams.get("type");
      if (type && !["purchase", "usage", "refund", "adjustment"].includes(type))
        invalid(
          "invalid_history_type",
          "type must be purchase, usage, refund or adjustment",
        );
      const before = cursor === null ? Infinity : integer(cursor, "cursor");
      const rows = entries
        .filter(
          (e) =>
            e.customer === customer &&
            e.seq < before &&
            (!type || e.type === type),
        )
        .reverse();
      const page = rows.slice(0, PAGE);
      return {
        status: 200,
        body: {
          data: page.map((e) => ({
            id: e.id,
            type: e.type,
            credits: String(e.credits),
            balance_after: String(e.balance_after),
            created_at: e.created_at,
            ...(e.event_id === undefined ? {} : { event_id: e.event_id }),
            ...(e.metadata === undefined ? {} : { metadata: e.metadata }),
            ...(e.note === undefined ? {} : { note: e.note }),
            ...(e.order === undefined ? {} : { order: e.order }),
          })),
          next_cursor:
            rows.length > PAGE ? String(page[page.length - 1]!.seq) : null,
        },
      };
    }
    throw new Refusal(404, "not_found", "no such route");
  }

  const handle = async (input: string | URL | Request, init?: RequestInit) => {
    try {
      const result = await route(new Request(input, init));
      return Response.json(result.body, { status: result.status });
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return Response.json(
        { code: error.code, message: error.message },
        { status: error.status },
      );
    }
  };

  const positive = (credits: string) => {
    const n = integer(credits, "credits");
    if (n <= 0) invalid("invalid_integer", "credits must be positive");
    return n;
  };
  return {
    config: { baseUrl: ORIGIN, apiKey },
    fetch: handle as typeof fetch,
    async grant(customer, credits) {
      append(customer, "adjustment", positive(credits), { note: "test grant" });
    },
    async purchase(customer, credits) {
      append(customer, "purchase", positive(credits), {
        order: {
          id: `ord_${hex()}`,
          amount: "100",
          currency: "usd",
          state: "fulfilled",
        },
      });
    },
    async payOrder(orderId) {
      const order = orders.find((o) => o.id === orderId);
      if (!order) throw new Error(`no order ${orderId}`);
      if (order.state === "fulfilled") return;
      order.state = "fulfilled";
      order.fulfilled_at = iso();
      append(order.customer, "purchase", Number(order.credits), {
        order: {
          id: order.id,
          amount: order.amount,
          currency: order.currency,
          state: "fulfilled",
        },
      });
    },
    close() {},
  };
};
