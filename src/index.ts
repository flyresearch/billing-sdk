// Billing 接入的最小实现：零依赖，只用 fetch，可直接粘贴进任何支持
// fetch 的后端（Node 18+、Bun、Deno、Cloudflare Workers），也可以作为
// @flyresearch/billing-sdk 安装。
//
// 产品后端只需要三件事：读余额、开始前冻结额度、结束后按实际用量结算。
// 下面把这三件事和它们之间的正确顺序一起给出——顺序才是容易出错的部分。

export interface BillingConfig {
  /** 服务地址，例如 https://billing.example.com */
  baseUrl: string;
  /** product.json 里的 api_key，只保存在后端 */
  apiKey: string;
  /** 默认用全局 fetch；测试时传 createTestBilling() 的 fetch */
  fetch?: typeof fetch;
}

export interface Balance {
  /** 还能消费的额度。已被冻结和退款锁定的部分不计入 */
  available: string;
  /** 调用进行中被冻结的额度，结算后释放 */
  held: string;
  spent: string;
  reversed: string;
  restricted_credits: string;
}

interface ReservationFields {
  reservation_id: string;
  held_credits: string;
  /** 授权截止时刻，UTC ISO。超过它结算会被拒绝 */
  work_until: string;
  rate_version: string;
}

/**
 * POST 冻结的回执。除 current 外的字段按创建时原样重放，不代表现在的状态；
 * current 是每次响应（包括重放）当场读出的冻结记录，执行前用它核对。
 */
export interface ReservationReceipt extends ReservationFields {
  operation_id: string;
  current: Reservation;
}

/** 冻结记录的当前状态：POST 回执的 current，或 GET 读回的结果 */
export interface Reservation extends ReservationFields {
  state: "held" | "settled" | "released" | "absorbed";
  /** 为真时停止发起新的执行，交由人工核对 */
  needs_review: boolean;
  task_id: string;
  slice_id: string;
  metric: string;
  max_units: string;
  result: unknown;
}

/** 可售的额度包。没有配置支付渠道时 offers 为空数组 */
export interface Catalog {
  config: Record<string, unknown>;
  /** 当前在售的额度包；同一产品可同时在售多档，币种一致。kind 为 flexible 时由用户在范围内自定金额 */
  offers: {
    kind?: "fixed" | "flexible";
    credits_per_unit?: string;
    min_amount?: string;
    max_amount?: string;
    step?: string;
    sku: string;
    price_id: string;
    /** 最小货币单位，例如 1000 表示 10.00 */
    amount: string;
    currency: string;
    /** 付款成功后发放的额度 */
    credits: string;
    /** 报价版本；自建购买页下单时带上，调价或下架后会得到 offer_changed */
    offer_version: string;
    /** 该币种最小货币单位的小数位数，例如 usd 为 2、jpy 为 0 */
    amount_decimals: number;
  }[];
  /** 产品开通的收款方式，例如 card、alipay、wechat_pay */
  payment_methods: string[];
  environment: "test" | "live";
}

/** 下单回执。HTTP 202，表示已受理，不代表已付款 */
export interface CheckoutReceipt {
  order_id: string;
  operation_id: string;
  state: "pending";
}

export interface Order {
  id: string;
  user_id: string;
  purchase_ref: string;
  sku: string;
  amount: string;
  currency: string;
  credits: string;
  state: "creating" | "awaiting_payment" | "fulfilled" | "expired" | "refunded";
  /** 收银台地址。刚下单时可能还是 null，要按原 order id 再查 */
  checkout_url: string | null;
  session_id: string | null;
  payment_intent: string | null;
  /** 非空表示有争议、部分退款或关闭后迟到付款，需要人工处理 */
  exception: string | null;
  created_at: string;
  fulfilled_at: string | null;
}

export class BillingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
  ) {
    super(code);
  }
}

export function createBillingClient(config: BillingConfig) {
  const call = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    // 幂等键：同一个键重发不会产生第二次消费，网络超时后原样重试即可。
    idempotencyKey?: string,
  ) => {
    const send = config.fetch ?? fetch;
    const response = await send(new URL(path, config.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": idempotencyKey ?? "",
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = (await response.json()) as Record<string, unknown>;
    if (!response.ok)
      throw new BillingError(
        response.status,
        String(result.code ?? response.status),
        result.request_id as string | undefined,
      );
    return result;
  };
  const account = (user: string) => `/v1/customers/${encodeURIComponent(user)}`;

  return {
    /** 当前可售的额度包。付款前从这里取 sku */
    catalog: () => call("GET", "/v1/catalog") as unknown as Promise<Catalog>,

    /**
     * 最省事的充值：为当前登录用户开一个托管充值页链接（30 分钟有效），
     * 把用户跳转过去即可。页面上选档、自定义金额、支付方式都由 Billing 提供，
     * 付款后回到你配置的 return origin。链接里不含产品凭据。
     */
    createTopupSession: (
      user: string,
      input: { return_path?: string } = {},
      key: string = crypto.randomUUID(),
    ) =>
      call(
        "POST",
        `${account(user)}/topup-sessions`,
        input,
        key,
      ) as unknown as Promise<{
        session_id: string;
        user_id: string;
        expires_at: string;
        url: string;
      }>,

    /**
     * 下单。返回 HTTP 202 和 order_id，此时还没有付款，
     * 也可能还没有收银台地址；按 order_id 再查。
     * purchase_ref 是你自己的购买引用，重试必须用同一个。
     */
    checkout: (
      user: string,
      input: { sku: string; purchase_ref: string; return_path?: string },
      idempotencyKey: string,
    ) =>
      call(
        "POST",
        `${account(user)}/checkouts`,
        input,
        idempotencyKey,
      ) as unknown as Promise<CheckoutReceipt>,

    /** 按订单 id 查当前状态。付款返回页面不是付款凭证，以这里为准 */
    order: (user: string, id: string) =>
      call(
        "GET",
        `${account(user)}/orders/${encodeURIComponent(id)}`,
      ) as unknown as Promise<Order>,

    /** 展示给用户看的充值记录 */
    orders: (user: string, cursor?: string) =>
      call(
        "GET",
        `${account(user)}/orders${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      ) as unknown as Promise<{
        data: Order[];
        has_more: boolean;
        next_cursor: string | null;
      }>,

    /** 展示给用户看的余额 */
    balance: (user: string) =>
      call("GET", `${account(user)}/balance`) as unknown as Promise<Balance>,

    /**
     * 执行前冻结额度。max_units 是这次调用最多可能用掉的量，
     * 余额不足会直接抛错，这正是"额度不足就停工"该发生的地方。
     */
    reserve: (
      user: string,
      input: {
        task_id: string;
        slice_id: string;
        metric: string;
        max_units: string;
      },
      idempotencyKey: string,
    ) =>
      call(
        "POST",
        `${account(user)}/reservations`,
        input,
        idempotencyKey,
      ) as unknown as Promise<ReservationReceipt>,

    /** 读回冻结记录，用于执行前核对和崩溃后判断 */
    reservation: (user: string, id: string) =>
      call(
        "GET",
        `${account(user)}/reservations/${encodeURIComponent(id)}`,
      ) as unknown as Promise<Reservation>,

    /**
     * 按实际用量结算，多冻结的部分自动退回可用余额。
     * 时间必须是 UTC ISO 毫秒格式，且落在授权期内；
     * actual_units 不能超过冻结时申报的 max_units。
     */
    settle: (
      user: string,
      id: string,
      input: {
        actual_units: string;
        started_at: string;
        ended_at: string;
        result_ref: string;
      },
      idempotencyKey: string,
    ) =>
      call(
        "POST",
        `${account(user)}/reservations/${encodeURIComponent(id)}/settle`,
        input,
        idempotencyKey,
      ),

    /**
     * 断言这次工作从未执行，整笔冻结退回。
     * 只有确认没有执行过才能调用；不确定时不要用它。
     */
    release: (
      user: string,
      id: string,
      reason: string,
      idempotencyKey: string,
    ) =>
      call(
        "POST",
        `${account(user)}/reservations/${encodeURIComponent(id)}/release`,
        { reason, confirmed_unconsumed: true },
        idempotencyKey,
      ),
  };
}

/** UTC ISO 毫秒，结算时间必须是这个格式 */
export const utcNow = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// 安全的一次收费执行
//
// 顺序是这段代码的全部价值。崩溃可能发生在任意两步之间，下面的顺序保证：
// 已经执行过的工作不会被重跑，已经发生的用量不会丢失计费。
// ---------------------------------------------------------------------------

/** 保存下来的可信计量。崩溃后按它原样补结算，时间也用它的 */
export interface Measurement {
  units: string;
  /** UTC ISO 毫秒 */
  started_at: string;
  ended_at: string;
}

/** 你的业务库需要提供的五个操作，用你自己的事务实现即可 */
export interface ChargeStore {
  /**
   * 保存这次任务的参数与幂等键；同一 task_id + slice_id 重复调用要返回已存记录。
   * outcome 为空的记录就是还没了结的，后台用 recoverCharge 逐条恢复。
   */
  begin(record: {
    task_id: string;
    slice_id: string;
    idempotency_key: string;
  }): Promise<{
    reservation_id?: string;
    /** claim 成功过就为 true */
    claimed?: boolean;
    measurement?: Measurement;
    outcome?: "settled" | "not_charged";
  }>;
  /** 记下冻结 id，必须在执行之前完成 */
  saveReservation(taskId: string, sliceId: string, id: string): Promise<void>;
  /** 原子地认领执行权：返回 false 表示别的进程已经在跑或跑过了 */
  claim(taskId: string, sliceId: string): Promise<boolean>;
  /** 先保存实际用量，再结算；崩溃后靠它重放 */
  saveMeasurement(
    taskId: string,
    sliceId: string,
    measurement: Measurement,
  ): Promise<void>;
  /** 记下了结方式：settled 已按用量扣费，not_charged 没有扣费 */
  finish(
    taskId: string,
    sliceId: string,
    outcome: "settled" | "not_charged",
  ): Promise<void>;
}

/**
 * execute 确认工作根本没开始时抛它（例如参数校验失败、上游明确拒绝），
 * 冻结会整笔退回。其他任何错误都当作"可能已经执行"，冻结保留待核实。
 */
export class NotExecuted extends Error {
  constructor(message = "not_executed") {
    super(message);
  }
}

/**
 * 一次收费执行的结果。只有 done 执行了工作；needs_review 表示可能已经执行，
 * 冻结保留，要人工或执行器核实后由维护者处理，不能重跑。
 */
export type ChargeOutcome<T> =
  | { status: "done"; result: T }
  /** 这一段早已了结，或这次把之前保存的用量补结算 / 把未执行的冻结退回了 */
  | { status: "finished"; outcome: "settled" | "not_charged" }
  /** 没有执行、没有扣费：额度不足、冻结待复核、已过期或不再是 held */
  | {
      status: "stopped";
      reason: "insufficient_credits" | "needs_review" | "expired" | "not_held";
    }
  /**
   * execution_unknown：执行抛了错，或别的进程认领了却没留下用量；
   * outside_window：用量已保存，但结束时间超过 work_until，结算被拒。
   */
  | {
      status: "needs_review";
      reason: "execution_unknown" | "outside_window";
      error?: unknown;
    };

type ChargeInput = {
  user: string;
  task_id: string;
  slice_id: string;
  metric: string;
  /** 这次调用最多可能用掉的量 */
  max_units: string;
};
type Billing = ReturnType<typeof createBillingClient>;
const refused = (error: unknown, code: string) =>
  error instanceof BillingError && error.code === code;

// 1. 先把业务请求落库，再冻结。先落库，崩溃后才知道有这笔任务存在。
//    同一幂等键重发不会产生第二笔冻结；回执的 current 是当场读出的状态，
//    不用再发 GET。恢复时手里只有 reservation_id，才需要读回来。
async function open(billing: Billing, store: ChargeStore, input: ChargeInput) {
  const key = `${input.task_id}:${input.slice_id}`;
  const saved = await store.begin({
    task_id: input.task_id,
    slice_id: input.slice_id,
    idempotency_key: key,
  });
  if (saved.outcome)
    return {
      ended: { status: "finished", outcome: saved.outcome } as const,
    };
  if (saved.reservation_id)
    return {
      key,
      saved,
      reservation: await billing.reservation(input.user, saved.reservation_id),
    };
  let reservation: Reservation;
  try {
    reservation = (
      await billing.reserve(
        input.user,
        {
          task_id: input.task_id,
          slice_id: input.slice_id,
          metric: input.metric,
          max_units: input.max_units,
        },
        key,
      )
    ).current;
  } catch (error) {
    // 额度不足就停工。什么都没冻结，这一段就此了结。
    if (!refused(error, "insufficient_credits")) throw error;
    await store.finish(input.task_id, input.slice_id, "not_charged");
    return {
      ended: { status: "stopped", reason: "insufficient_credits" } as const,
    };
  }
  await store.saveReservation(
    input.task_id,
    input.slice_id,
    reservation.reservation_id,
  );
  return { key, saved, reservation };
}

// 冻结已不是 held：别人（或上一轮）已经了结了它，照实记下。
async function alreadyClosed(
  store: ChargeStore,
  input: ChargeInput,
  reservation: Reservation,
) {
  const outcome = reservation.state === "settled" ? "settled" : "not_charged";
  await store.finish(input.task_id, input.slice_id, outcome);
  return { status: "finished", outcome } as const;
}

// 按保存的用量和时间结算。崩溃恢复走同一条路，所以时间必须是当初保存的。
async function settleSaved(
  billing: Billing,
  store: ChargeStore,
  input: ChargeInput,
  key: string,
  reservation: Reservation,
  measurement: Measurement,
): Promise<ChargeOutcome<never>> {
  if (reservation.state !== "held")
    return alreadyClosed(store, input, reservation);
  try {
    await billing.settle(
      input.user,
      reservation.reservation_id,
      {
        actual_units: measurement.units,
        started_at: measurement.started_at,
        ended_at: measurement.ended_at,
        result_ref: key,
      },
      `${key}:settle`,
    );
  } catch (error) {
    // 工作超过了授权期。用量留在你的库里，冻结保留，交给维护者处理。
    if (refused(error, "usage_outside_authorization"))
      return { status: "needs_review", reason: "outside_window", error };
    throw error;
  }
  await store.finish(input.task_id, input.slice_id, "settled");
  return { status: "finished", outcome: "settled" };
}

// 认领之后才退回：认领了就没人会再执行它，这时断言"未执行"才成立。
async function releaseUnrun(
  billing: Billing,
  store: ChargeStore,
  input: ChargeInput,
  key: string,
  reservation: Reservation,
  reason: string,
) {
  await billing.release(
    input.user,
    reservation.reservation_id,
    reason,
    `${key}:release`,
  );
  await store.finish(input.task_id, input.slice_id, "not_charged");
}

export async function chargedRun<T>(
  billing: Billing,
  store: ChargeStore,
  input: ChargeInput,
  /**
   * 真实业务。返回实际用量，必须是可信计量，不能由前端传入。
   * 必须在 work_until 之前结束；更长的工作拆成多段，每段一个 slice_id。
   */
  execute: (authorization: {
    work_until: string;
    max_units: string;
  }) => Promise<{ units: string; result: T }>,
): Promise<ChargeOutcome<T>> {
  const opened = await open(billing, store, input);
  if (opened.ended) return opened.ended;
  const { key, saved, reservation } = opened;

  // 2. 崩溃恢复：已经量过用量就只补结算，绝不重跑业务。
  if (saved.measurement)
    return settleSaved(
      billing,
      store,
      input,
      key,
      reservation,
      saved.measurement,
    );
  if (saved.claimed)
    return { status: "needs_review", reason: "execution_unknown" };

  // 3. 执行前核对授权：状态、复核标记和有效期都要满足，否则不执行。
  if (reservation.state !== "held")
    return { status: "stopped", reason: "not_held" };
  if (reservation.needs_review)
    return { status: "stopped", reason: "needs_review" };

  // 4. 原子认领。没抢到说明别的进程已经在执行，直接退出，不重复消费。
  if (!(await store.claim(input.task_id, input.slice_id)))
    return { status: "needs_review", reason: "execution_unknown" };
  if (Date.parse(reservation.work_until) <= Date.now()) {
    await releaseUnrun(
      billing,
      store,
      input,
      key,
      reservation,
      "expired_before_start",
    );
    return { status: "stopped", reason: "expired" };
  }

  const startedAt = utcNow();
  let measured: { units: string; result: T };
  try {
    measured = await execute({
      work_until: reservation.work_until,
      max_units: input.max_units,
    });
  } catch (error) {
    // 只有确认没开始才退回。其余错误可能发生在工作之后（例如响应丢失），
    // 此时退回等于白送服务，还在账上写下"未消费"的假话；保留冻结待核实。
    if (!(error instanceof NotExecuted))
      return { status: "needs_review", reason: "execution_unknown", error };
    await releaseUnrun(
      billing,
      store,
      input,
      key,
      reservation,
      "never_executed",
    );
    return { status: "finished", outcome: "not_charged" };
  }
  const measurement = {
    units: measured.units,
    started_at: startedAt,
    ended_at: utcNow(),
  };

  // 5. 先保存用量，再结算。顺序反了，崩溃就会丢掉这次计费。
  await store.saveMeasurement(input.task_id, input.slice_id, measurement);
  const settled = await settleSaved(
    billing,
    store,
    input,
    key,
    reservation,
    measurement,
  );
  return settled.status === "finished"
    ? { status: "done", result: measured.result }
    : settled;
}

/**
 * 后台恢复一条没了结的记录（begin 返回的 outcome 为空），绝不执行业务：
 * 有保存的用量就按原值补结算；从未认领的冻结先认领再整笔退回；
 * 认领了却没留下用量的，返回 needs_review，保留冻结待核实。
 * 对库里超过 work_until 仍未了结的记录定期调用即可。
 */
export async function recoverCharge(
  billing: Billing,
  store: ChargeStore,
  input: ChargeInput,
): Promise<ChargeOutcome<never>> {
  const opened = await open(billing, store, input);
  if (opened.ended) return opened.ended;
  const { key, saved, reservation } = opened;
  if (saved.measurement)
    return settleSaved(
      billing,
      store,
      input,
      key,
      reservation,
      saved.measurement,
    );
  if (saved.claimed)
    return { status: "needs_review", reason: "execution_unknown" };
  if (reservation.state !== "held")
    return alreadyClosed(store, input, reservation);
  if (!(await store.claim(input.task_id, input.slice_id)))
    return { status: "needs_review", reason: "execution_unknown" };
  await releaseUnrun(billing, store, input, key, reservation, "never_executed");
  return { status: "finished", outcome: "not_charged" };
}

// ---------------------------------------------------------------------------
// 充值
//
// 同样是顺序问题：先把购买引用和 SKU 落到你自己的库里，再下单。
// 重试时用保存的 SKU，不要重新读 catalog——商品可能已经改版，
// 那会让用户付了旧价钱拿到新商品，或者相反。
// ---------------------------------------------------------------------------

/** 你的业务库需要提供的两个操作 */
export interface TopUpStore {
  /** 保存购买意图；同一 purchase_ref 重复调用要返回已存记录 */
  beginPurchase(record: {
    user: string;
    purchase_ref: string;
    sku: string;
  }): Promise<{ sku: string; order_id?: string }>;
  /** 记下订单号，之后靠它查询状态 */
  saveOrder(purchaseRef: string, orderId: string): Promise<void>;
}

export async function startTopUp(
  billing: ReturnType<typeof createBillingClient>,
  store: TopUpStore,
  input: {
    user: string;
    /** 你自己的购买引用，一次购买一个，重试保持不变 */
    purchase_ref: string;
    /** 用户选的额度包。第一次从 catalog 取 */
    sku: string;
    /** 付款后回跳到你产品的哪个路径，需要产品先配置 return origin */
    return_path?: string;
  },
): Promise<Order> {
  // 1. 先落库。重试时拿回原来的 SKU，不重新读 catalog。
  const saved = await store.beginPurchase({
    user: input.user,
    purchase_ref: input.purchase_ref,
    sku: input.sku,
  });

  // 2. 下单。返回 202，只说明已受理。
  const orderId =
    saved.order_id ??
    (
      await billing.checkout(
        input.user,
        {
          sku: saved.sku,
          purchase_ref: input.purchase_ref,
          ...(input.return_path ? { return_path: input.return_path } : {}),
        },
        input.purchase_ref,
      )
    ).order_id;
  await store.saveOrder(input.purchase_ref, orderId);

  // 3. 查订单。刚下单时 checkout_url 可能还是 null，让用户稍后重试即可。
  return billing.order(input.user, orderId);
}

/**
 * 付款结果只能以服务端订单状态为准：用户回跳到你的页面不代表付款成功。
 * fulfilled 表示额度已发放，此时再读一次余额即可。
 * exception 非空表示有争议或部分退款，要人工处理，不能当作正常完成。
 */
export function topUpOutcome(order: Order): {
  done: boolean;
  needsAttention: boolean;
  message: string;
} {
  if (order.exception)
    return {
      done: false,
      needsAttention: true,
      message: `订单需要人工处理：${order.exception}`,
    };
  switch (order.state) {
    case "fulfilled":
      return { done: true, needsAttention: false, message: "额度已到账" };
    case "awaiting_payment":
      return { done: false, needsAttention: false, message: "等待付款" };
    case "creating":
      return { done: false, needsAttention: false, message: "正在创建订单" };
    case "expired":
      return {
        done: false,
        needsAttention: false,
        message: "订单已过期，请重新发起",
      };
    case "refunded":
      return { done: false, needsAttention: true, message: "订单已退款" };
  }
}
