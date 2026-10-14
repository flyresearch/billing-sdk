// Billing 产品接口（API v1，ADR-0014）的客户端。零依赖，只用 fetch，
// Node 18+、Bun、Deno、Cloudflare Workers 都能用。
//
// 模型：先用后报。开始前读一次余额（allowed 为 false 就不开始）；执行中按固定
// 间隔上报已发生的用量；响应里 allowed 变成 false 就结束。用 createMeter 即可。

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
    const result = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
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
     * return_path（需要在控制台配置回跳站点）。
     */
    createTopupSession: (id: string, options: { return_path?: string } = {}) =>
      call<{ url: string; expires_at: string }>(
        "POST",
        `${customer(id)}/topup-sessions`,
        options,
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
      return call<{ data: HistoryEntry[]; next_cursor: string | null }>(
        "GET",
        `${customer(id)}/history${suffix}`,
      );
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
  /** 余额用尽（allowed 为 false）时调用一次，产品在这里结束工作 */
  onStop?: (standing: Standing) => void;
  /** 上报失败时调用；这一批用量会以同一个事件 ID 在下一轮重试 */
  onError?: (error: unknown) => void;
}

/**
 * 按间隔批量上报用量。add() 累加，定时以递增的事件 ID 上报；网络失败时同一批
 * 用量保持原事件 ID 重试，所以不会重复扣费。进程崩溃最多丢一个间隔的用量
 * （对商户是少收，不是多收）。
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
  let sending: Promise<void> | null = null;

  const send = async () => {
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
      if (!result.allowed && !stopped) {
        stopped = true;
        options.onStop?.({ balance: result.balance, allowed: result.allowed });
      }
    } catch (error) {
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
      buffered += value;
    },
    /** 立即上报累计的用量 */
    flush,
    /** 余额是否已用尽 */
    get stopped() {
      return stopped;
    },
    /** 停止定时上报，并把剩余用量报完；失败会抛错，可再次调用重试 */
    async close() {
      clearInterval(timer);
      while (sending) await sending.catch(() => {});
      while (pending || buffered > 0n) await flush();
    },
  };
}
