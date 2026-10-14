// Billing 产品接口（API v1，ADR-0014）的客户端。零依赖，只用 fetch，
// Node 20+（需要全局 crypto.subtle）、Bun、Deno、Cloudflare Workers 都能用。
//
// 模型：先用后报。开始前读一次余额（allowed 为 false 就不开始）；执行中按固定
// 间隔上报已发生的用量；响应里 allowed 变成 false 就结束。用 createMeter 即可。
//
// 充值两条路：createTopupSession 把用户送到 Billing 托管的充值页（省事）；或者
// 在产品自己的界面里用 catalog 列出额度包、checkout 建单、order 读结果（交互与
// UI 和产品统一）。

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
}

export interface HistoryEntry {
  id: string;
  type: "purchase" | "usage" | "refund" | "adjustment";
  /** 正数为增加，负数为扣减 */
  credits: string;
  balance_after: string;
  created_at: string;
  event_id?: string;
  metadata?: Record<string, string>;
  note?: string;
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

export interface Catalog {
  /** 按上架顺序；没有配置收款时为空 */
  offers: Offer[];
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

/** 建单回执（HTTP 202）：只说明已受理，订单状态以 order() 为准 */
export type CheckoutReceipt =
  | { order_id: string; operation_id: string; state: "pending" }
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
  /** Stripe 收银台地址；刚建单时可能还是 null，稍后再读 */
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

// The default checkout key: one per customer and purchase_ref, of fixed length
// and plain ASCII whatever the IDs are (the service caps keys at 200 characters,
// and HTTP headers take no arbitrary Unicode).
async function checkoutKey(customer: string, purchaseRef: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${customer}\n${purchaseRef}`),
  );
  return `checkout:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function createBillingClient(config: BillingConfig) {
  const call = async <T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> => {
    const send = config.fetch ?? fetch;
    const response = await send(new URL(path, config.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey === undefined
          ? {}
          : { "idempotency-key": idempotencyKey }),
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
     */
    reportUsage: (
      id: string,
      usage: {
        event_id: string;
        units: string;
        metadata?: Record<string, string>;
      },
    ) => call<UsageResult>("POST", `${customer(id)}/usage`, usage),

    /**
     * 托管充值页链接（30 分钟有效）。把用户的浏览器送过去，付完回到产品的
     * return_path（需要在控制台配置回跳站点）。同一个 key 同样参数重发返回同一个
     * 链接；不传则每次新建。
     */
    createTopupSession: (
      id: string,
      options: { return_path?: string } = {},
      key: string = crypto.randomUUID(),
    ) =>
      call<{ url: string; expires_at: string }>(
        "POST",
        `${customer(id)}/topup-sessions`,
        options,
        key,
      ),

    /** 在售额度包与收款方式，自建购买页用 */
    catalog: () => call<Catalog>("GET", "/v1/catalog"),

    /**
     * 自建购买页建单。purchase_ref 先存进产品自己的库再调用；重试用同一个
     * purchase_ref（幂等键默认由客户和它派生），不会建第二单。回执是
     * offer_changed 时这次购买已终结：用户重新确认后换一个新的 purchase_ref。
     * 回执只说明已受理：
     * 用 order() 读 checkout_url（可能稍后才有）并把浏览器送过去，付款结果也以
     * order() 和余额为准，回跳页面不是付款凭证。
     */
    checkout: async (id: string, input: CheckoutInput, key?: string) =>
      call<CheckoutReceipt>(
        "POST",
        `${customer(id)}/checkouts`,
        input,
        key ?? (await checkoutKey(id, input.purchase_ref)),
      ),

    /** 一个订单的当前状态 */
    order: (id: string, orderId: string) =>
      call<Order>(
        "GET",
        `${customer(id)}/orders/${encodeURIComponent(orderId)}`,
      ),

    /** 这个客户的订单，新的在前 */
    orders: (id: string, options: { cursor?: string } = {}) =>
      call<{ data: Order[]; has_more: boolean; next_cursor: string | null }>(
        "GET",
        `${customer(id)}/orders${options.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : ""}`,
      ),

    /** 充值、用量、退款、调账记录，新的在前，每页 50 条 */
    history: (
      id: string,
      options: { cursor?: string; type?: HistoryEntry["type"] } = {},
    ) => {
      const query = new URLSearchParams();
      if (options.cursor) query.set("cursor", options.cursor);
      if (options.type) query.set("type", options.type);
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
  /**
   * 余额用尽（allowed 为 false）或账户已关闭（409 account_closed）时调用一次，
   * 产品在这里结束工作
   */
  onStop?: (standing: Standing) => void;
  /** 上报失败时调用；暂时性失败会重试这一批，永久拒绝会丢弃这一批（见 createMeter） */
  onError?: (error: unknown) => void;
}

/**
 * Billing 明确拒绝（不是故障）：4xx 且不是 invalid_response。408、429 是
 * “稍后再试”，仍算暂时性失败。
 */
function refused(error: unknown): error is BillingError {
  return (
    error instanceof BillingError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429 &&
    error.code !== "invalid_response"
  );
}

/**
 * 按间隔批量上报用量。add() 累加，定时以递增的事件 ID 上报。进程崩溃最多丢一个
 * 间隔的用量（对商户是少收，不是多收）。失败分两种：
 *
 * - 暂时性（网络错误、超时、5xx、408、429、invalid_response）：调用 onError，
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
  } | null = null;
  let stopped = false;
  let closed = false;
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
      if (!closed) buffered += value;
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
