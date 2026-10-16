// 产品测试用的内存 Billing（API v1，ADR-0014）。按公开接口的规则行为，不含
// Billing 服务端代码：事件 ID 冲突、余额用尽、非法输入都会像生产一样返回。
// 与真服务的一致性由 ./contract.ts 的契约测试保证：同一套测试在这里对它跑，
// 在 Billing 仓库里对真服务跑。不覆盖托管充值页、Stripe 与管理端：建单得到的
// checkout_url 不能打开，付款用 payOrder() 模拟。
//
// 档位（ADR-0015）：免费档每个自然月（UTC）在第一次读写时发放，先于其他额度
// 使用，月底作废（契约测试覆盖）。订阅是简化模拟、不在契约内：开通后用
// paySubscription() 模拟首期付款，每期到期自动续费并发放下一期额度（除非已设到期
// 取消），换档、取消、客户管理页按公开接口的规则回答。
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

/** 测试用档位；price 为 "0" 即免费档（至多一个） */
export interface TestPlan {
  sku: string;
  name?: string;
  /** 每月价格，最小货币单位 */
  price: string;
  currency?: string;
  /** 每期额度 */
  credits: string;
  entitlements?: Record<string, unknown>;
}

export interface TestBillingOptions {
  /** 在售额度包，按顺序；默认没有。payments 为 false 时 catalog 不列出 */
  offers?: TestOffer[];
  /** 在售档位；默认没有 */
  plans?: TestPlan[];
  /** 每单位用量扣多少额度，默认 1 */
  creditsPerUnit?: number;
  /** 计量名，默认 units；初始版本为 v1 */
  metric?: string;
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
  /** 模拟负责人修改计量（ADR-0016）：生成新版本，只影响之后的用量 */
  setMeter(meter: { metric: string; credits_per_unit: string }): Promise<void>;
  close(): void;
}

export type CreateTestBilling = (
  options?: TestBillingOptions,
) => Promise<TestBilling>;

/** 内存假服务独有的订阅模拟（真服务的订阅经 Stripe，不在契约内） */
export interface FakeBilling extends TestBilling {
  /** 模拟订阅收银台付款成功：订阅生效，发放首期额度 */
  paySubscription(subscriptionId: string): Promise<void>;
}

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
  type: "purchase" | "usage" | "refund" | "adjustment" | "expiry";
  credits: number;
  balance_after: number;
  created_at: string;
  event_id?: string;
  request?: string;
  metadata?: Record<string, string>;
  note?: string;
  units?: string;
  /** The metric the units were measured in, for summing a group. */
  metric?: string;
  group?: string;
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
  checkout_url: string | null;
  exception: null;
  created_at: string;
  fulfilled_at: string | null;
}

interface Allowance {
  key: string;
  total: number;
  remaining: number;
  expires_at: string;
  subscription?: string;
}
interface Subscription {
  id: string;
  customer: string;
  purchase_ref: string;
  plan_sku: string;
  state: "checkout" | "active" | "canceled" | "checkout_expired";
  cancel_at_period_end: boolean;
  period_end: string | null;
  checkout_url: string;
  /** 本期已付过的档位：升回其中之一不再扣款 */
  paid: string[];
}
// The same day of the next month, in UTC (as a monthly Stripe period).
const nextMonth = (at: string) => {
  const d = new Date(at);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
};

export const createTestBilling = async (
  options: TestBillingOptions = {},
): Promise<FakeBilling> => {
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const apiKey = `bk_test_${hex()}`;
  let meter = {
    version: "v1",
    metric: options.metric ?? "units",
    credits_per_unit: String(options.creditsPerUnit ?? 1),
  };
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
  // Checkout refusals, durable per (customer, purchase_ref) as in the service:
  // a refused purchase_ref never creates an order.
  const refusals = new Map<string, string>();
  const publicOrder = ({ seq: _, customer: __, ...order }: TestOrder) => order;

  const plans = (options.plans ?? [])
    .map((plan) => ({
      sku: plan.sku,
      name: plan.name ?? plan.sku,
      price: plan.price,
      currency: plan.currency ?? "usd",
      credits: plan.credits,
      entitlements: plan.entitlements ?? {},
    }))
    .sort((a, b) => Number(BigInt(a.price) - BigInt(b.price)));
  const free = plans.find((plan) => plan.price === "0") ?? null;
  const allowances = new Map<string, Allowance[]>();
  const subscriptions: Subscription[] = [];

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

  // A monthly allowance: it repays debt first, like any credit, and only
  // what is left of it can be spent or expire.
  function grantAllowance(
    customer: string,
    allowance: Omit<Allowance, "remaining">,
  ) {
    const list = allowances.get(customer) ?? [];
    if (list.some((a) => a.key === allowance.key)) return;
    const debt = Math.max(0, -balanceOf(customer));
    append(customer, "adjustment", allowance.total, { note: "allowance" });
    list.push({
      ...allowance,
      remaining: allowance.total - Math.min(allowance.total, debt),
    });
    allowances.set(customer, list);
  }
  const activeSubscription = (customer: string) =>
    subscriptions.find((s) => s.customer === customer && s.state === "active");
  // Before anything reads or changes a customer: renew or end subscriptions
  // whose period ended, expire what is due, then grant the month's free
  // allowance when no subscription is active.
  function touch(customer: string) {
    const at = iso();
    const sub = activeSubscription(customer);
    while (sub && sub.state === "active" && sub.period_end! <= at) {
      if (sub.cancel_at_period_end) sub.state = "canceled";
      else {
        sub.period_end = nextMonth(sub.period_end!);
        sub.paid = [sub.plan_sku];
        const plan = plans.find((p) => p.sku === sub.plan_sku)!;
        if (sub.period_end > at)
          grantAllowance(customer, {
            key: `invoice.${sub.id}.${sub.period_end}`,
            total: Number(plan.credits),
            expires_at: sub.period_end,
            subscription: sub.id,
          });
      }
    }
    for (const allowance of allowances.get(customer) ?? [])
      if (allowance.expires_at <= at && allowance.remaining > 0) {
        append(customer, "expiry", -allowance.remaining);
        allowance.remaining = 0;
      }
    if (free && !activeSubscription(customer)) {
      const d = new Date(now());
      grantAllowance(customer, {
        key: `free.${at.slice(0, 7)}`,
        total: Number(free.credits),
        expires_at: new Date(
          Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
        ).toISOString(),
      });
    }
  }
  // Usage spends monthly allowances first, soonest expiry first.
  function spendAllowances(customer: string, credits: number) {
    const list = [...(allowances.get(customer) ?? [])].sort((a, b) =>
      a.expires_at < b.expires_at ? -1 : a.expires_at > b.expires_at ? 1 : 0,
    );
    for (const allowance of list) {
      const take = Math.min(allowance.remaining, credits);
      allowance.remaining -= take;
      credits -= take;
    }
  }
  function planView(customer: string) {
    touch(customer);
    const sub = activeSubscription(customer);
    const plan = sub ? plans.find((p) => p.sku === sub.plan_sku)! : free;
    const periodEnd = sub
      ? sub.period_end
      : free
        ? new Date(
            Date.UTC(
              new Date(now()).getUTCFullYear(),
              new Date(now()).getUTCMonth() + 1,
              1,
            ),
          ).toISOString()
        : null;
    const current = (allowances.get(customer) ?? []).filter((a) =>
      sub
        ? a.subscription === sub.id && a.expires_at === sub.period_end
        : !a.subscription && a.expires_at === periodEnd,
    );
    return {
      plan,
      period_end: periodEnd,
      allowance: current.length
        ? {
            total: String(current.reduce((n, a) => n + a.total, 0)),
            remaining: String(current.reduce((n, a) => n + a.remaining, 0)),
            expires_at: periodEnd,
          }
        : null,
      subscription: sub
        ? {
            id: sub.id,
            status: "active",
            cancel_at_period_end: sub.cancel_at_period_end,
            current_period_end: sub.period_end,
          }
        : null,
    };
  }
  function paidPlan(sku: unknown) {
    const plan = plans.find((p) => p.sku === id(sku, "plan_sku"));
    if (!plan) invalid("unsupported_plan", "no such plan on sale");
    if (plan!.price === "0")
      invalid(
        "free_plan_not_subscribable",
        "the free plan needs no subscription",
      );
    return plan!;
  }
  const fields = (input: Record<string, unknown>, allowed: string[]) => {
    for (const key of Object.keys(input))
      if (!allowed.includes(key))
        invalid("unexpected_field", `unknown field ${key}`);
  };
  const returnPath = (path: unknown) => {
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
  };
  const notConfigured = () => {
    throw new Refusal(
      503,
      "stripe_not_configured",
      "this product has no Stripe configuration",
    );
  };

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
          config: meter,
          plans,
          payment_methods: payments ? ["card"] : [],
        },
      };
    if (
      parts[0] !== "v1" ||
      parts[1] !== "customers" ||
      (parts.length !== 4 &&
        !(parts.length === 5 && ["orders", "plan"].includes(parts[3]!)))
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
    const action = `${request.method} ${parts.slice(3).join("/")}`;
    if (action === "GET balance") {
      touch(customer);
      return { status: 200, body: standing(balanceOf(customer)) };
    }
    if (action === "GET plan") return { status: 200, body: planView(customer) };
    if (action === "POST subscription-checkouts") {
      const input = await body(request);
      fields(input, ["plan_sku", "purchase_ref", "return_path"]);
      const ref = id(input.purchase_ref, "purchase_ref");
      returnPath(input.return_path);
      if (!payments) notConfigured();
      const previous = subscriptions.find(
        (s) => s.customer === customer && s.purchase_ref === ref,
      );
      let sub = previous;
      if (previous && previous.plan_sku !== input.plan_sku)
        invalid("unsupported_plan", "a purchase_ref keeps its original plan");
      if (!sub) {
        const plan = paidPlan(input.plan_sku);
        touch(customer);
        if (activeSubscription(customer))
          throw new Refusal(
            409,
            "subscription_exists",
            "the user already subscribes; change the plan instead",
          );
        // An open checkout of the user is expired first.
        for (const s of subscriptions)
          if (s.customer === customer && s.state === "checkout")
            s.state = "checkout_expired";
        const subId = `sub_${hex()}`;
        sub = {
          id: subId,
          customer,
          purchase_ref: ref,
          plan_sku: plan.sku,
          state: "checkout",
          cancel_at_period_end: false,
          period_end: null,
          checkout_url: `${ORIGIN}/checkout/${subId}`,
          paid: [],
        };
        subscriptions.push(sub);
      }
      return {
        status: 201,
        body: {
          subscription_id: sub.id,
          plan_sku: sub.plan_sku,
          state: sub.state,
          checkout_url: sub.state === "checkout" ? sub.checkout_url : null,
        },
      };
    }
    if (action === "POST plan") {
      const input = await body(request);
      fields(input, ["plan_sku"]);
      const target = paidPlan(input.plan_sku);
      if (!payments) notConfigured();
      touch(customer);
      const sub = activeSubscription(customer);
      if (!sub)
        throw new Refusal(409, "subscription_required", "no subscription");
      if (sub.plan_sku === target.sku)
        throw new Refusal(409, "plan_unchanged", "already on this plan");
      // Charged only above every plan the period was paid for; the paid
      // difference tops the period up to the new plan's credits.
      const charge = sub.paid.every(
        (sku) =>
          BigInt(target.price) >
          BigInt(plans.find((p) => p.sku === sku)!.price),
      );
      if (charge) {
        sub.paid.push(target.sku);
        const due = (allowances.get(customer) ?? [])
          .filter(
            (a) => a.subscription === sub.id && a.expires_at === sub.period_end,
          )
          .reduce((n, a) => n + a.total, 0);
        const top = Number(target.credits) - due;
        if (top > 0)
          grantAllowance(customer, {
            key: `invoice.${sub.id}.${sub.period_end}.${target.sku}`,
            total: top,
            expires_at: sub.period_end!,
            subscription: sub.id,
          });
      }
      sub.plan_sku = target.sku;
      return { status: 200, body: planView(customer) };
    }
    if (action === "POST plan/cancel" || action === "POST plan/resume") {
      fields(await body(request), []);
      if (!payments) notConfigured();
      touch(customer);
      const sub = activeSubscription(customer);
      if (!sub)
        throw new Refusal(409, "subscription_required", "no subscription");
      sub.cancel_at_period_end = action === "POST plan/cancel";
      return { status: 200, body: planView(customer) };
    }
    if (action === "POST billing-portal") {
      const input = await body(request);
      fields(input, ["return_path"]);
      returnPath(input.return_path);
      if (!payments) notConfigured();
      if (!subscriptions.some((s) => s.customer === customer))
        throw new Refusal(409, "subscription_required", "no Stripe customer");
      return {
        status: 200,
        body: { url: `${ORIGIN}/portal/${encodeURIComponent(customer)}` },
      };
    }
    if (action === "POST usage") {
      const input = await body(request);
      for (const key of Object.keys(input))
        if (
          !["event_id", "units", "metadata", "meter_version", "group"].includes(
            key,
          )
        )
          invalid("unexpected_field", `unknown field ${key}`);
      const eventId = id(input.event_id, "event_id");
      const units = integer(input.units, "units");
      const meterVersion =
        input.meter_version === undefined
          ? null
          : id(input.meter_version, "meter_version");
      const group = input.group === undefined ? null : id(input.group, "group");
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
      const request_ = canonical({
        customer,
        units,
        metadata,
        ...(group === null ? {} : { group }),
      });
      touch(customer);
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
            meter_version: meter.version,
          },
        };
      }
      if (meterVersion !== null && meterVersion !== meter.version)
        throw new Refusal(
          409,
          "meter_changed",
          "the meter changed; report again in the new unit",
        );
      const credits = units * Number(meter.credits_per_unit);
      if (!Number.isSafeInteger(credits))
        invalid("integer_overflow", "units out of range");
      spendAllowances(customer, credits);
      const balance = append(customer, "usage", -credits, {
        event_id: eventId,
        request: request_,
        units: String(units),
        metric: meter.metric,
        ...(metadata === null ? {} : { metadata }),
        ...(group === null ? {} : { group }),
      });
      return {
        status: 200,
        body: {
          event_id: eventId,
          credits: String(credits),
          ...standing(balance),
          meter_version: meter.version,
        },
      };
    }
    if (action === "POST topup-sessions") {
      const input = await body(request);
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
      // Every call opens a new link; an extra one has no side effect.
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
      const { offer_version } = input;
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
      // The purchase is named by (customer, purchase_ref): a retry answers its
      // order as it is now, and a refused purchase_ref stays refused.
      let order = orders.find(
        (o) => o.customer === customer && o.purchase_ref === ref,
      );
      if (order && input.sku !== order.sku)
        invalid("unsupported_sku", "a purchase_ref keeps its original sku");
      const refusalKey = canonical([customer, ref]);
      const refused = order ? undefined : refusals.get(refusalKey);
      if (refused !== undefined)
        return { status: 201, body: { state: "rejected", reason: refused } };
      if (!order && offer_version !== undefined) {
        const current = offers.find((o) => o.sku === input.sku);
        if (!current || current.offer_version !== offer_version) {
          refusals.set(refusalKey, "offer_changed");
          return {
            status: 201,
            body: { state: "rejected", reason: "offer_changed" },
          };
        }
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
      return {
        status: 201,
        body: {
          order_id: order.id,
          state: order.state,
          checkout_url: order.checkout_url,
        },
      };
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
      const grouped = url.searchParams.get("grouped");
      if (
        type &&
        !["purchase", "usage", "refund", "adjustment", "expiry"].includes(type)
      )
        invalid(
          "invalid_history_type",
          "type must be purchase, usage, refund, adjustment or expiry",
        );
      if (grouped !== null && grouped !== "true" && grouped !== "false")
        invalid("invalid_history_grouped", "grouped must be true or false");
      touch(customer);
      const before = cursor === null ? Infinity : integer(cursor, "cursor");
      const own = entries.filter((e) => e.customer === customer);
      // Grouped, a group's reports become one line placed and identified by
      // its first report, showing its total and its latest report.
      type Line = Entry & { reports?: number; started_at?: string };
      let lines: Line[] = own;
      if (grouped === "true") {
        const groups = new Map<string, Entry[]>();
        lines = [];
        for (const e of own)
          if (e.group === undefined) lines.push(e);
          else groups.set(e.group, [...(groups.get(e.group) ?? []), e]);
        for (const reports of groups.values()) {
          const latest = reports[reports.length - 1]!;
          lines.push({
            ...latest,
            seq: reports[0]!.seq,
            id: reports[0]!.id,
            credits: reports.reduce((sum, e) => sum + e.credits, 0),
            // Units of different metrics add up to nothing meaningful.
            units: reports.every((e) => e.metric === reports[0]!.metric)
              ? reports
                  .reduce((sum, e) => sum + BigInt(e.units ?? "0"), 0n)
                  .toString()
              : undefined,
            reports: reports.length,
            started_at: reports[0]!.created_at,
          });
        }
        lines.sort((a, b) => a.seq - b.seq);
      }
      const rows = lines
        .filter((e) => e.seq < before && (!type || e.type === type))
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
            ...(e.units === undefined ? {} : { units: e.units }),
            ...(e.group === undefined ? {} : { group: e.group }),
            ...(e.reports === undefined
              ? {}
              : { reports: e.reports, started_at: e.started_at }),
            ...(e.order === undefined ? {} : { order: e.order }),
          })),
          has_more: rows.length > PAGE,
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
    async setMeter(next) {
      id(next.metric, "metric");
      if (integer(next.credits_per_unit, "credits_per_unit") <= 0)
        invalid("invalid_integer", "credits_per_unit must be positive");
      if (
        next.metric === meter.metric &&
        next.credits_per_unit === meter.credits_per_unit
      )
        return;
      const n = /^m([1-9][0-9]{0,8})$/.exec(meter.version);
      meter = {
        version: `m${n ? Number(n[1]) + 1 : 2}`,
        metric: next.metric,
        credits_per_unit: next.credits_per_unit,
      };
    },
    async paySubscription(subscriptionId) {
      const sub = subscriptions.find((s) => s.id === subscriptionId);
      if (!sub) throw new Error(`no subscription ${subscriptionId}`);
      if (sub.state !== "checkout") return;
      sub.state = "active";
      sub.period_end = nextMonth(iso());
      sub.paid = [sub.plan_sku];
      grantAllowance(sub.customer, {
        key: `invoice.${sub.id}.${sub.period_end}`,
        total: Number(plans.find((p) => p.sku === sub.plan_sku)!.credits),
        expires_at: sub.period_end,
        subscription: sub.id,
      });
    },
    close() {},
  };
};
