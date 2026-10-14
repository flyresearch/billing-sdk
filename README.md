# @flyresearch/billing-sdk

Billing 产品接口（API v1）的客户端，以及给产品自己写测试用的内存 Billing。

模型是**先用后报**：开始工作前读一次余额，执行中按间隔上报已经发生的用量，余额用尽时 Billing 告诉你停下。超支最多一个上报间隔，下一次充值先抵扣。

- `@flyresearch/billing-sdk`：零依赖、只用 `fetch` 的客户端和 `createMeter`。Node 18+、Bun、Deno、Cloudflare Workers 都能用。
- `@flyresearch/billing-sdk/testing`：内存假服务，按公开接口的规则行为。
- `@flyresearch/billing-sdk/contract`：契约测试。同一套测试在这里对假服务跑，在 Billing 服务仓库里对真服务跑，保证两者一致。

## 安装

```sh
bun add github:flyresearch/billing-sdk#v0.3.0  # 自建购买页的方法在 main，待发布 v0.4.0
```

源码是 TypeScript，直接被 Bun、Deno 和 Workers 的打包器使用。`v0.1.x` 是旧接口（冻结与结算）。`v0.3` 起错误码与 Billing 服务一致：输入不合法是 422 加具体错误码（如 `invalid_integer`、`invalid_identifier`），未配置收款是 503 `stripe_not_configured`，订单完成状态为 `fulfilled`。

## 接口

| 方法                                                    | 作用                                                  |
| ------------------------------------------------------- | ----------------------------------------------------- |
| `balance(customer)`                                     | `{ balance, allowed }`；`allowed` 为 false 就不开始   |
| `reportUsage(customer, { event_id, units, metadata? })` | 上报已发生的用量。`event_id` 即幂等键，重发不重复扣费 |
| `history(customer, { cursor?, type? })`                 | 充值、用量、退款、调账记录                            |
| `catalog()`                                             | 在售额度包（固定档与自定金额档）和收款方式            |
| `checkout(customer, { sku, purchase_ref, ... })`        | 在产品自己的购买页建单；同一 `purchase_ref` 只建一单  |
| `order(customer, id)` / `orders(customer)`              | 订单状态与 `checkout_url`，付款结果以它和余额为准     |
| `createTopupSession(customer, { return_path? })`        | 托管充值页链接（30 分钟有效）：不想自己画购买页时用   |

客户 ID 由你的产品定义，第一次出现时自动建立。金额和额度都是十进制整数字符串。

## 用法

```ts
import { createBillingClient, createMeter } from "@flyresearch/billing-sdk";

const billing = createBillingClient({ baseUrl, apiKey }); // 控制台签发的产品密钥

// 开始前
if (!(await billing.balance(userId)).allowed)
  return showTopUp(await billing.createTopupSession(userId));

// 执行中
const meter = createMeter(billing, {
  customer: userId,
  eventPrefix: sessionId, // 每次工作唯一
  intervalMs: 5000,
  onStop: () => endSession("insufficient_credits"),
});
meter.add(measuredUnits); // 每测到一段用量就加

// 结束时
await meter.close(); // 把剩余用量报完
```

上报失败时，同一批用量会以原事件 ID 在下一轮重试，不会重复扣费。进程崩溃最多丢一个间隔的用量（对商户是少收，不是多收）。

## 自建购买页

```ts
const { offers } = await billing.catalog();
// 用户在产品界面里选了 offer；purchaseRef 先存进产品自己的库，重试沿用
const receipt = await billing.checkout(userId, {
  sku: offer.sku,
  purchase_ref: purchaseRef,
  offer_version: offer.offer_version, // 套餐变了会返回 { state: "rejected", reason: "offer_changed" }
  return_path: "/billing", // 需要在控制台配置回跳站点
});
if (receipt.state === "pending") {
  const order = await billing.order(userId, receipt.order_id);
  if (order.checkout_url) redirect(order.checkout_url); // 可能稍后才有，再读一次
}
```

回跳页面不是付款凭证：回来后读 `order()` 的 `state`（`fulfilled` 即已到账）和余额。自定金额档传 `amount`（最小货币单位），额度 = 金额 × `credits_per_unit`。

## 测试

```ts
import { createBillingClient } from "@flyresearch/billing-sdk";
import { createTestBilling } from "@flyresearch/billing-sdk/testing";

const billing = await createTestBilling({ creditsPerUnit: 1 });
const client = createBillingClient({ ...billing.config, fetch: billing.fetch });
await billing.grant("user_1", "1000"); // 测试额度
await billing.purchase("user_1", "5000"); // 模拟一次已付款的充值
// 自建购买页：createTestBilling({ offers: [...] }) 上架额度包，checkout 建单后
// billing.payOrder(orderId) 模拟付款成功
```

选项：`offers`（在售额度包）、`creditsPerUnit`、`payments`（false 时充值链接返回 503 `stripe_not_configured`）、`returnOrigin`（允许 `return_path`）、`now`。

假服务只覆盖产品接口，不包括托管充值页、Stripe 和管理端；通过它不代表部署可用。

## 许可

MIT
