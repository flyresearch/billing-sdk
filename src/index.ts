// Billing 产品接口（API v1，ADR-0014、ADR-0015、ADR-0016）的客户端。零依赖，只用 fetch，
// Node 18+、Bun、Deno、Cloudflare Workers 都能用。
//
// 不发送 Idempotency-Key：Billing 按请求指向的对象识别重试。用量看 event_id，
// 建单看（客户，purchase_ref），响应丢失后用相同请求重发即可。
//
// 模型：先用后报。开始前读一次余额（allowed 为 false 就不开始）；执行中按固定
// 间隔上报已发生的用量；响应里 allowed 变成 false 就结束。用 createMeter 即可。
//
// 充值两条路：createTopupSession 把用户送到 Billing 托管的充值页（省事）；或者
// 在产品自己的界面里用 catalog 列出额度包、checkout 建单、order 读结果（交互与
// UI 和产品统一）。
//
// 订阅档位（ADR-0015）：plan 读用户当前档位、权益和本期月度额度；月度额度先于
// 额度包使用，期末作废、不结转。付费档用 subscriptionCheckout 开通，changePlan
// 换档，cancelPlan / resumePlan 到期取消与撤销，billingPortal 打开 Stripe 客户
// 管理页。托管充值页也能完成这些操作。

export interface BillingConfig {
  /** 服务地址，例如 https://billkernel.com */
  baseUrl: string;
  /** 控制台签发的产品密钥，只放在后端 */
  apiKey: string;
  /** 默认用全局 fetch；测试时传 createTestBilling() 的 fetch */
  fetch?: typeof fetch;
}

export interface Standing {
  /** 余额，十进制整数字符串，可以为负 */
  balance: string;
  /** 余额 > 0：可以开始或继续工作 */
  allowed: boolean;
}

export interface UsageResult extends Standing {
  event_id: string;
  /** 这条用量扣了多少额度 */
  credits: string;
  /** 当前计量版本（ADR-0016） */
  meter_version: string;
}

/** 产品的计量（ADR-0016）：一条用量扣 units × credits_per_unit 额度 */
export interface Meter {
  /** 负责人每次修改计量都会生成新版本 */
  version: string;
  /** 计量名，如 voice_seconds */
  metric: string;
  credits_per_unit: string;
}

export interface HistoryEntry {
  id: string;
  /** 月度额度发放记为 adjustment（note 为 "allowance"），期末作废记为 expiry */
  type: "purchase" | "usage" | "refund" | "adjustment" | "expiry";
  /** 正数为增加，负数为扣减 */
  credits: string;
  balance_after: string;
  created_at: string;
  event_id?: string;
  metadata?: Record<string, string>;
  note?: string;
  /**
   * 仅用量：上报的单位数（整数字符串）。grouped 行是各次上报原样相加，不随
   * 费率变化，适合显示时长；同一 group 中途换了计量单位时相加没有意义。
   */
  units?: string;
  /** 上报时带的 group（一次通话或会话） */
  group?: string;
  /** 仅 grouped 读取：这一行合计了几次上报 */
  reports?: number;
  /** 仅 grouped 读取：这个 group 第一次上报的时间 */
  started_at?: string;
  order?: { id: string; amount: string; currency: string; state: string };
}

/** 在售额度包。金额是最小货币单位的整数字符串，主单位 = 金额 ÷ 10^amount_decimals */
export interface Offer {
  /** 省略或 fixed：固定价与额度；flexible：用户在 min_amount..max_amount 内按 step 自定金额 */
  kind?: "fixed" | "flexible";
  sku: string;
  /** 报价版本：建单时原样带回，套餐变了会被拒（offer_changed），不会按新价成交 */
  offer_version: string;
  currency: string;
  /** fixed 的价格；flexible 的预填金额 */
  amount: string;
  /** fixed 的额度；flexible 预填金额对应的额度 */
  credits: string;
  amount_decimals: number;
  /** 仅 flexible：额度 = 金额 × credits_per_unit */
  credits_per_unit?: string;
  min_amount?: string;
  max_amount?: string;
  step?: string;
}

/** 档位（ADR-0015）。价格是最小货币单位的整数字符串，"0" 即免费档 */
export interface Plan {
  sku: string;
  name: string;
  /** 每月价格 */
  price: string;
  currency: string;
  /** 每期发放的月度额度 */
  credits: string;
  /** 产品自己定义的权益对象，Billing 原样返回；限流等由产品执行 */
  entitlements: Record<string, unknown>;
}

/** 用户当前的档位、订阅与本期月度额度 */
export interface CustomerPlan {
  /** 有效订阅的档位，否则免费档；都没有时为 null */
  plan: Plan | null;
  /** 本期结束：订阅的计费周期结束，免费档为下月 1 日 00:00 UTC */
  period_end: string | null;
  /** 本期月度额度；尚未发放时为 null */
  allowance: { total: string; remaining: string; expires_at: string } | null;
  subscription: {
    id: string;
    status: "active" | "trialing" | "past_due";
    /** 已设为到期取消 */
    cancel_at_period_end: boolean;
    current_period_end: string;
  } | null;
}

export interface SubscriptionCheckoutInput {
  plan_sku: string;
  /** 产品自己的购买引用；重试用同一个，得到同一个订阅 */
  purchase_ref: string;
  /** 付完回到产品的路径（需要在控制台配置回跳站点） */
  return_path?: string;
}

/**
 * 开通结果（HTTP 201）。state 为 checkout 时把浏览器送到 checkout_url（只收银行
 * 卡，1 小时内有效）；checkout_url 为 null 表示上次没拿到 Stripe 的回答，用同一个
 * purchase_ref 重试。付款后档位经 Webhook 生效，以 plan() 为准。
 */
export interface SubscriptionReceipt {
  subscription_id: string;
  plan_sku: string;
  /** checkout、checkout_expired，或付款后 Stripe 订阅的状态 */
  state: string;
  checkout_url: string | null;
}

export interface Catalog {
  /** 当前计量；上报用量时把 version 作为 meter_version 带上 */
  config: Meter;
  /** 按上架顺序；没有配置收款时为空 */
  offers: Offer[];
  /** 在售档位，按价格从低到高 */
  plans: Plan[];
  /** 产品开通的收款方式，如 card、alipay、wechat_pay */
  payment_methods: string[];
}

export interface CheckoutInput {
  sku: string;
  /** 产品自己的购买引用，先存进自己的库；重试用同一个，不会建第二单 */
  purchase_ref: string;
  /** catalog 里该档的 offer_version；省略则不做报价核对 */
  offer_version?: string;
  /** 仅 flexible：最小货币单位的整数字符串，fixed 不能传 */
  amount?: string;
  /** 只接受 catalog.payment_methods 之一；省略则收银台展示全部 */
  payment_method?: string;
  /** 付完回到产品的路径（需要在控制台配置回跳站点） */
  return_path?: string;
}

/**
 * 建单结果（HTTP 201）：建单当场返回收银台地址。通常 state 为 awaiting_payment、
 * checkout_url 可直接打开；同一个 purchase_ref 重发返回同一订单的当前状态（可能已
 * fulfilled、expired、refunded）。只有之前的响应丢失且 Stripe 仍不可用时才可能是
 * creating、checkout_url 为 null：用同一个 purchase_ref 重试即可。
 */
export type CheckoutReceipt =
  | { order_id: string; state: Order["state"]; checkout_url: string | null }
  | { state: "rejected"; reason: "offer_changed" };

export interface Order {
  id: string;
  purchase_ref: string;
  sku: string;
  amount: string;
  currency: string;
  credits: string;
  /** creating → awaiting_payment → fulfilled；另有 expired、refunded */
  state: "creating" | "awaiting_payment" | "fulfilled" | "expired" | "refunded";
  /** Stripe 收银台地址；只有 creating（建单响应丢失后）时为 null */
  checkout_url: string | null;
  /** 非空表示需要人工核实（争议、部分退款等） */
  exception: string | null;
  created_at: string;
  fulfilled_at: string | null;
}

export class BillingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

export function createBillingClient(config: BillingConfig) {
  const call = async <T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const send = config.fetch ?? fetch;
    const response = await send(new URL(path, config.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    const isObject =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    // A success that is not a JSON object is not a result: never read it as an
    // empty one (that would turn `allowed` into undefined, i.e. "stop").
    if (response.ok && !isObject)
      throw new BillingError(
        response.status,
        "invalid_response",
        "Billing answered with a body that is not a JSON object",
      );
    const result = (isObject ? parsed : {}) as Record<string, unknown>;
    if (!response.ok)
      throw new BillingError(
        response.status,
        String(result.code ?? response.status),
        String(result.message ?? result.code ?? `HTTP ${response.status}`),
      );
    return result as T;
  };
  const customer = (id: string) => `/v1/customers/${encodeURIComponent(id)}`;

  return {
    /** 当前余额。开始工作前读一次，allowed 为 false 就不开始 */
    balance: (id: string) => call<Standing>("GET", `${customer(id)}/balance`),

    /**
     * 上报已经发生的用量。event_id 就是幂等键：同一个 event_id 同样内容重发
     * 返回原结果，不会重复扣费；内容不同返回 409 event_conflict。
     * 用量一定会被记账；响应的 allowed 为 false 时结束工作。
     * 带上 meter_version（catalog().config.version）时，负责人改过计量会返回
     * 409 meter_changed、不记账：重读计量，换算成新单位后重报（可沿用 event_id）。
     * group（一次通话或会话的标识）属于事件内容；history({ grouped: true })
     * 把同一 group 的上报合成一行。
     */
    reportUsage: (
      id: string,
      usage: {
        event_id: string;
        units: string;
        metadata?: Record<string, string>;
        meter_version?: string;
        group?: string;
      },
    ) => call<UsageResult>("POST", `${customer(id)}/usage`, usage),

    /**
     * 托管充值页链接（30 分钟有效）。把用户的浏览器送过去，付完回到产品的
     * return_path（需要在控制台配置回跳站点）。每次调用都返回一个新链接；
     * 多建一个没有副作用，响应丢失时直接再调用即可。
     */
    createTopupSession: (id: string, options: { return_path?: string } = {}) =>
      call<{ url: string; expires_at: string }>(
        "POST",
        `${customer(id)}/topup-sessions`,
        options,
      ),

    /** 在售额度包与收款方式，自建购买页用 */
    catalog: () => call<Catalog>("GET", "/v1/catalog"),

    /**
     * 自建购买页建单。purchase_ref 先存进产品自己的库再调用；Billing 按（客户，
     * purchase_ref）识别这次购买，重试用同一个 purchase_ref，不会建第二单。回执是
     * offer_changed 时这次购买已终结，这个 purchase_ref 之后重发也只会得到同一个
     * 拒绝：用户重新确认后换一个新的 purchase_ref。
     * 结果里直接带 checkout_url，把浏览器送过去即可；503 时用同一个 purchase_ref
     * 重试，会拿到同一个订单与同一个收银台。付款结果以 order() 和余额为准，
     * 回跳页面不是付款凭证。
     */
    checkout: (id: string, input: CheckoutInput) =>
      call<CheckoutReceipt>("POST", `${customer(id)}/checkouts`, input),

    /** 一个订单的当前状态 */
    order: (id: string, orderId: string) =>
      call<Order>(
        "GET",
        `${customer(id)}/orders/${encodeURIComponent(orderId)}`,
      ),

    /**
     * 当前档位、权益与本期月度额度。和查余额一样，读取时先作废到期的额度，
     * 再按需发放本月免费档额度。权益可以缓存几分钟。
     */
    plan: (id: string) => call<CustomerPlan>("GET", `${customer(id)}/plan`),

    /**
     * 开通付费档：返回订阅收银台地址。已有订阅时 409 subscription_exists（改用
     * changePlan）；免费档或已下架档位 422。
     */
    subscriptionCheckout: (id: string, input: SubscriptionCheckoutInput) =>
      call<SubscriptionReceipt>(
        "POST",
        `${customer(id)}/subscription-checkouts`,
        input,
      ),

    /**
     * 换档，立即生效。新档价格高于本期已付过的档位时，立即按剩余天数扣差价并补发
     * 额度差（扣款失败 409 plan_change_payment_failed，档位不变）；其余换档不扣款
     * 不退款，下期按新档。另一次换档未完成时 409 plan_change_in_progress。
     */
    changePlan: (id: string, planSku: string) =>
      call<CustomerPlan>("POST", `${customer(id)}/plan`, {
        plan_sku: planSku,
      }),

    /** 到期取消：本期照常使用，结束后回到免费档 */
    cancelPlan: (id: string) =>
      call<CustomerPlan>("POST", `${customer(id)}/plan/cancel`, {}),

    /** 撤销到期取消 */
    resumePlan: (id: string) =>
      call<CustomerPlan>("POST", `${customer(id)}/plan/resume`, {}),

    /** Stripe 客户管理页链接（换卡、发票、取消），之后回到产品 */
    billingPortal: (id: string, options: { return_path?: string } = {}) =>
      call<{ url: string }>("POST", `${customer(id)}/billing-portal`, options),

    /** 这个客户的订单，新的在前 */
    orders: (id: string, options: { cursor?: string } = {}) =>
      call<{ data: Order[]; has_more: boolean; next_cursor: string | null }>(
        "GET",
        `${customer(id)}/orders${options.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : ""}`,
      ),

    /**
     * 充值、用量、退款、调账记录，新的在前，每页 50 条。grouped 为 true 时，
     * 同一 group 的用量合成一行：id 与位置取第一次上报（固定不变，边上报边
     * 翻页不重复不遗漏），credits 为合计，余额与时间取最后一次上报，另带
     * reports 与 started_at。
     */
    history: (
      id: string,
      options: {
        cursor?: string;
        type?: HistoryEntry["type"];
        grouped?: boolean;
      } = {},
    ) => {
      const query = new URLSearchParams();
      if (options.cursor) query.set("cursor", options.cursor);
      if (options.type) query.set("type", options.type);
      if (options.grouped) query.set("grouped", "true");
      const suffix = query.size ? `?${query}` : "";
      return call<{
        data: HistoryEntry[];
        has_more: boolean;
        next_cursor: string | null;
      }>("GET", `${customer(id)}/history${suffix}`);
    },
  };
}

export type BillingClient = ReturnType<typeof createBillingClient>;

export interface MeterOptions {
  customer: string;
  /** 这次工作的唯一前缀，例如会话 ID；事件 ID 为 `${eventPrefix}:${序号}` */
  eventPrefix: string;
  /** 上报间隔，默认 5000 毫秒。间隔越短，余额用尽后的超支越少 */
  intervalMs?: number;
  /** 随每条用量记入流水的字符串键值（≤1 KB），例如是哪个 Agent 在运行 */
  metadata?: Record<string, string>;
  /** 这次工作的 group（例如通话 ID），随每条用量上报，流水可按它合成一行 */
  group?: string;
  /**
   * 余额用尽（allowed 为 false）或账户已关闭（409 account_closed）时调用一次，
   * 产品在这里结束工作
   */
  onStop?: (standing: Standing) => void;
  /** 上报失败时调用；暂时性失败会重试这一批，永久拒绝会丢弃这一批（见 createMeter） */
  onError?: (error: unknown) => void;
  /**
   * 计量版本（catalog().config.version），随每条用量上报。和 onMeterChanged
   * 一起给：负责人改了计量时，meter 停止上报，把还没记账的用量（旧单位）交给
   * onMeterChanged，由产品换算成新单位后用新的 meter 继续。
   */
  meterVersion?: string;
  onMeterChanged?: (unreportedUnits: bigint) => void;
}

/**
 * Billing 明确拒绝（不是故障）：4xx 且不是 invalid_response。408、429 是
 * “稍后再试”；401、403 是密钥被吊销或配错，修好后这些用量还要报上去，都算
 * 暂时性失败。
 */
function refused(error: unknown): error is BillingError {
  return (
    error instanceof BillingError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 403, 408, 429].includes(error.status) &&
    error.code !== "invalid_response"
  );
}

/**
 * 按间隔批量上报用量。add() 累加，定时以递增的事件 ID 上报。进程崩溃最多丢一个
 * 间隔的用量（对商户是少收，不是多收）。失败分两种：
 *
 * - 暂时性（网络错误、超时、5xx、401、403、408、429、invalid_response）：调用 onError，
 *   同一批用量保持原事件 ID 在下一轮重试，所以不会重复扣费。
 * - 永久拒绝（其余 4xx，如 event_conflict、invalid_metadata、invalid_integer）：
 *   调用 onError，丢弃这一批（重试也只会再被拒），之后的用量照常上报。
 *   409 account_closed 例外：账户已关闭、无法再扣费，调用一次 onStop（带最后
 *   一次已知的余额，没有则为 { balance: "0", allowed: false }），丢弃累计的用量
 *   并不再上报。
 *
 * flush() 和 close() 在两种失败时都会抛出该错误；account_closed 不抛。
 */
export function createMeter(client: BillingClient, options: MeterOptions) {
  let buffered = 0n;
  let sequence = 0;
  let pending: {
    event_id: string;
    units: string;
    metadata?: Record<string, string>;
    meter_version?: string;
    group?: string;
  } | null = null;
  let stopped = false;
  let closed = false;
  let meterChanged = false;
  let last: Standing = { balance: "0", allowed: false };
  let sending: Promise<void> | null = null;

  const stop = (standing: Standing) => {
    if (stopped) return;
    stopped = true;
    options.onStop?.(standing);
  };
  const send = async () => {
    if (closed) return;
    if (!pending && buffered > 0n) {
      pending = {
        event_id: `${options.eventPrefix}:${++sequence}`,
        units: buffered.toString(),
        ...(options.metadata ? { metadata: options.metadata } : {}),
        ...(options.group ? { group: options.group } : {}),
        ...(options.meterVersion
          ? { meter_version: options.meterVersion }
          : {}),
      };
      buffered = 0n;
    }
    if (!pending) return;
    try {
      const result = await client.reportUsage(options.customer, pending);
      pending = null;
      last = { balance: result.balance, allowed: result.allowed };
      if (!result.allowed) stop(last);
    } catch (error) {
      if (refused(error) && error.code === "meter_changed") {
        // Nothing of this batch was recorded: hand it over, with what came
        // after it, to be converted and reported in the new meter.
        closed = true;
        meterChanged = true;
        clearInterval(timer);
        const unreported = BigInt(pending!.units) + buffered;
        pending = null;
        buffered = 0n;
        options.onMeterChanged?.(unreported);
        return;
      }
      if (refused(error) && error.code === "account_closed") {
        closed = true;
        clearInterval(timer);
        pending = null;
        buffered = 0n;
        stop(last);
        return;
      }
      if (refused(error)) pending = null;
      options.onError?.(error);
      throw error;
    }
  };
  const flush = (): Promise<void> =>
    (sending ??= send().finally(() => (sending = null)));
  const timer = setInterval(
    () => void flush().catch(() => {}),
    options.intervalMs ?? 5000,
  );

  return {
    /** 记一笔已经发生的用量（单位与产品的计量单位一致，非负整数） */
    add(units: number | bigint) {
      const value = BigInt(units);
      if (value < 0n) throw new RangeError("units must not be negative");
      // After a meter change nothing is reported here; later units go the
      // same way as the unreported ones, so none is lost.
      if (meterChanged) {
        if (value > 0n) options.onMeterChanged?.(value);
      } else if (!closed) buffered += value;
    },
    /** 立即上报累计的用量 */
    flush,
    /** 余额是否已用尽（或账户已关闭） */
    get stopped() {
      return stopped;
    },
    /** 停止定时上报，并把剩余用量报完；失败会抛错，可再次调用重试 */
    async close() {
      clearInterval(timer);
      while (sending) await sending.catch(() => {});
      while (!closed && (pending || buffered > 0n)) await flush();
    },
  };
}
