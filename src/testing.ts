// 产品测试用的内存 Billing（API v1，ADR-0014）。按公开接口的规则行为，不含
// Billing 服务端代码：事件 ID 冲突、余额用尽、非法输入都会像生产一样返回。
// 与真服务的一致性由 ./contract.ts 的契约测试保证：同一套测试在这里对它跑，
// 在 Billing 仓库里对真服务跑。不覆盖托管充值页、Stripe 与管理端。
//
//   const billing = await createTestBilling();
//   const client = createBillingClient({ ...billing.config, fetch: billing.fetch });
//   billing.grant("user_1", "1000");

export interface TestBillingOptions {
  /** 每单位用量扣多少额度，默认 1 */
  creditsPerUnit?: number;
  /** 是否已配置收款，默认 true；false 时建充值链接返回 payments_not_configured */
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
  close(): void;
}

export type CreateTestBilling = (
  options?: TestBillingOptions,
) => Promise<TestBilling>;

const ORIGIN = "https://billing.test";
const PAGE = 50;

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const invalid = (message: string): never => {
  throw new Refusal(400, "invalid_request", message);
};
function id(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    invalid(
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
    invalid(`${field} must be a decimal integer string`);
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

export const createTestBilling: CreateTestBilling = async (options = {}) => {
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const apiKey = `bk_test_${hex()}`;
  const creditsPerUnit = options.creditsPerUnit ?? 1;
  const balances = new Map<string, number>();
  const entries: Entry[] = [];
  let seq = 0;

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
      invalid("body is not JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
      invalid("body must be a JSON object");
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
    if (parts[0] !== "v1" || parts[1] !== "customers" || parts.length !== 4)
      throw new Refusal(404, "not_found", "no such route");
    const customer = id(parts[2], "customer");
    const action = `${request.method} ${parts[3]}`;
    if (action === "GET balance")
      return { status: 200, body: standing(balanceOf(customer)) };
    if (action === "POST usage") {
      const input = await body(request);
      for (const key of Object.keys(input))
        if (!["event_id", "units", "metadata"].includes(key))
          invalid(`unknown field ${key}`);
      const eventId = id(input.event_id, "event_id");
      const units = integer(input.units, "units");
      const metadata = (input.metadata ?? null) as Record<
        string,
        string
      > | null;
      if (metadata !== null) {
        if (typeof metadata !== "object" || Array.isArray(metadata))
          invalid("metadata must be an object of strings");
        if (Object.values(metadata).some((v) => typeof v !== "string"))
          invalid("metadata values must be strings");
        if (new TextEncoder().encode(JSON.stringify(metadata)).length > 1024)
          invalid("metadata must be at most 1 KB");
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
      if (!Number.isSafeInteger(credits)) invalid("units out of range");
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
      for (const key of Object.keys(input))
        if (key !== "return_path") invalid(`unknown field ${key}`);
      const path = input.return_path;
      if (
        path !== undefined &&
        (typeof path !== "string" ||
          path.length > 512 ||
          !path.startsWith("/") ||
          path.startsWith("//") ||
          path.includes("\\"))
      )
        invalid("return_path must be a path starting with /");
      if (options.payments === false)
        throw new Refusal(
          409,
          "payments_not_configured",
          "this product has no Stripe configuration",
        );
      if (path !== undefined && !options.returnOrigin)
        invalid("return_path needs the product's return origin configured");
      return {
        status: 201,
        body: {
          url: `${ORIGIN}/topup/ts_${hex()}`,
          expires_at: new Date(now() + 30 * 60_000).toISOString(),
        },
      };
    }
    if (action === "GET history") {
      const cursor = url.searchParams.get("cursor");
      const type = url.searchParams.get("type");
      if (type && !["purchase", "usage", "refund", "adjustment"].includes(type))
        invalid("type must be purchase, usage, refund or adjustment");
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
    if (n <= 0) invalid("credits must be positive");
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
          state: "paid",
        },
      });
    },
    close() {},
  };
};
