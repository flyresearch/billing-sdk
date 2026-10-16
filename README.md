# @flyresearch/billing-sdk

Billing 产品接口（API v1）的客户端，以及给产品自己写测试用的内存 Billing。

模型是**先用后报**：开始工作前读一次余额，执行中按间隔上报已经发生的用量，余额用尽时 Billing 告诉你停下。超支最多一个上报间隔，下一次充值先抵扣。

- `@flyresearch/billing-sdk`：零依赖、只用 `fetch` 的客户端和 `createMeter`。Node 18+、Bun、Deno、Cloudflare Workers 都能用。
- `@flyresearch/billing-sdk/testing`：内存假服务，按公开接口的规则行为。
- `@flyresearch/billing-sdk/contract`：契约测试。同一套测试在这里对假服务跑，在 Billing 服务仓库里对真服务跑，保证两者一致。

## 安装

```sh
bun add github:flyresearch/billing-sdk#v0.10.1
```

源码是 TypeScript，直接被 Bun、Deno 和 Workers 的打包器使用。`v0.1.x` 是旧接口（冻结与结算）。`v0.3` 起错误码与 Billing 服务一致：输入不合法是 422 加具体错误码（如 `invalid_integer`、`invalid_identifier`），未配置收款是 503 `stripe_not_configured`，订单完成状态为 `fulfilled`。

**v0.6 的不兼容变化**：客户端不再发送 `Idempotency-Key`，Billing 也不再读它。`checkout(customer, input, key?)` 与 `createTopupSession(customer, options, key?)` 去掉了第三个参数（key），`409 idempotency_conflict` 不再出现。重试由请求本身识别，不需要另配幂等键：用量看 `event_id`，建单看（客户，`purchase_ref`）。充值链接每次调用都是新的，同一个 key 不再返回同一个链接。

**v0.10** 用量条目带 `units`（需要 Billing core schema 13，只加不改）：上报的单位数，汇总行是各次上报原样相加，不随费率变化，适合显示时长。

**v0.9** 按通话汇总流水（需要 Billing core schema 12，只加不改）：`reportUsage` 可带 `group`（一次通话或会话的标识，属于事件内容），`createMeter` 增加 `group` 选项；`history(customer, { grouped: true })` 把同一 group 的用量合成一行（`id` 与位置取第一次上报、固定不变，`credits` 为合计，余额与时间取最后一次上报，另带 `reports`、`started_at`）；流水条目多 `group` 字段。假服务同样支持。

**v0.8** 支持计量修改（ADR-0016，只加不改）：`catalog().config`（`version`、`metric`、`credits_per_unit`）进了类型；`reportUsage` 可带 `meter_version`，负责人改过计量时返回 409 `meter_changed`、不记账；`createMeter` 增加 `meterVersion` 与 `onMeterChanged`；用量回答多一个 `meter_version` 字段。假服务支持 `metric` 选项与 `billing.setMeter()`。

**v0.7** 增加订阅档位（只加不改）：`catalog().plans`、`plan()`、`subscriptionCheckout()`、`changePlan()`、`cancelPlan()`、`resumePlan()`、`billingPortal()`；流水多一种类型 `expiry`（月度额度到期作废），月度额度发放记为 `adjustment`、`note` 为 `"allowance"`。没处理 `expiry` 的界面会把它当成未知类型，请补上显示。

## 接口

| 方法                                                                       | 作用                                                                                      |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `balance(customer)`                                                        | `{ balance, allowed }`；`allowed` 为 false 就不开始                                       |
| `reportUsage(customer, { event_id, units, metadata?, group? })`            | 上报已发生的用量。按 `event_id` 识别，重发不重复扣费                                      |
| `history(customer, { cursor?, type?, grouped? })`                          | 充值、用量、退款、调账记录；`grouped` 按 group 合成一行                                   |
| `catalog()`                                                                | 在售额度包（固定档与自定金额档）和收款方式                                                |
| `checkout(customer, { sku, purchase_ref, ... })`                           | 在产品自己的购买页建单；同一 `purchase_ref` 只建一单                                      |
| `order(customer, id)` / `orders(customer)`                                 | 订单状态与 `checkout_url`，付款结果以它和余额为准                                         |
| `createTopupSession(customer, { return_path? })`                           | 托管充值页链接（30 分钟有效），每次调用都是新链接；页面也展示档位，可订阅、换档、管理订阅 |
| `plan(customer)`                                                           | 当前档位、权益、本期结束与本期月度额度                                                    |
| `subscriptionCheckout(customer, { plan_sku, purchase_ref, return_path? })` | 开通付费档，返回订阅收银台地址；同一 `purchase_ref` 得到同一订阅                          |
| `changePlan(customer, planSku)`                                            | 换档，立即生效；价格更高时立即扣差价并补发额度差                                          |
| `cancelPlan(customer)` / `resumePlan(customer)`                            | 到期取消 / 撤销取消                                                                       |
| `billingPortal(customer, { return_path? })`                                | Stripe 客户管理页（换卡、发票、取消）                                                     |

客户 ID 由你的产品定义，第一次出现时自动建立。金额和额度都是十进制整数字符串。

重试是安全的，靠的是请求里的业务标识，而不是请求头：用量按 `event_id`，建单按（客户，`purchase_ref`），响应丢失后原样重发即可。充值链接多建一个没有副作用，直接再调用。

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

上报失败按 Billing 的回答分开处理（前两种调用 `onError`，`flush()` / `close()` 也会抛出该错误）：

- **暂时性**（网络错误、超时、5xx、401/403（密钥被吊销或配错，修好后还要报上去）、408、429，以及 2xx 但响应体不是 JSON 对象的 `invalid_response`）：同一批用量以原事件 ID 在下一轮重试，不会重复扣费。
- **永久拒绝**（其余 4xx，如 `event_conflict`、`invalid_metadata`、`invalid_integer`）：这是 Billing 的回答，不是故障，重试也只会再被拒。这一批被丢弃，之后的用量照常上报。
- 例外：409 `account_closed` 表示账户已关闭、无法再扣费。meter 调用一次 `onStop`（带最后一次已知的余额，没有则为 `{ balance: "0", allowed: false }`），丢弃累计的用量并不再上报，不调用 `onError`。

进程崩溃最多丢一个间隔的用量（对商户是少收，不是多收）。

### 计量修改（ADR-0016）

负责人可以在控制台修改产品的计量（比如从毫秒改成秒）。为了不把旧单位的用量按新单位记账，上报时带上计量版本：

```ts
const { config } = await billing.catalog(); // { version, metric, credits_per_unit }
const meter = createMeter(billing, {
  customer: userId,
  eventPrefix: sessionId,
  meterVersion: config.version,
  onMeterChanged: (units) => {
    // 这些用量（旧单位）没有记账：重读 config，换算成新单位后交给新的 meter
  },
});
```

计量改了以后，meter 停止上报，把没记账的用量和之后 `add` 的用量都交给 `onMeterChanged`，不会丢，也不会按新单位记旧数。不带版本的产品按当前计量记账；这种产品在负责人修改计量前，要先停止新工作、报完已有用量。

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
if (receipt.state !== "rejected" && receipt.checkout_url)
  redirect(receipt.checkout_url); // 建单当场返回收银台地址
```

建单当场返回收银台地址（HTTP 201）。Stripe 暂时不可用时返回 503：用同一个 `purchase_ref` 重试，会拿到同一个订单和同一个收银台，不会建第二单；同一个 `purchase_ref` 重发总是返回该订单的当前状态。回跳页面不是付款凭证：回来后读 `order()` 的 `state`（`fulfilled` 即已到账）和余额。回执是 `offer_changed` 时这次购买已终结：这个拒绝按（客户，`purchase_ref`）保存，之后用同一个 `purchase_ref` 重发（哪怕带上新的 `offer_version`）也只会得到同一个拒绝。用户重新确认价格后换一个新的 `purchase_ref`。自定金额档传 `amount`（最小货币单位），额度 = 金额 × `credits_per_unit`。

## 订阅档位

档位由负责人在控制台配置：每月价格、每期额度和产品自己定义的权益（如 `{ "rpm": 120 }`）。月度额度先于额度包使用，期末作废、不结转；额度包永不过期。免费档（价格为 0）每个自然月（UTC）在用户第一次被读写时发放。

```ts
const { plan, allowance, subscription } = await billing.plan(userId);
applyLimits(plan?.entitlements); // 权益由产品执行，可缓存几分钟

// 开通：purchaseRef 先存进产品自己的库，重试沿用
const receipt = await billing.subscriptionCheckout(userId, {
  plan_sku: "pro",
  purchase_ref: purchaseRef,
});
if (receipt.checkout_url) redirect(receipt.checkout_url); // 只收银行卡，1 小时有效

// 已订阅：换档、到期取消、管理订阅
await billing.changePlan(userId, "team"); // 409 plan_change_payment_failed：让用户在管理页换卡
await billing.cancelPlan(userId);
redirect((await billing.billingPortal(userId)).url);
```

付款后档位经 Webhook 生效，以 `plan()` 为准；回跳页面不是付款凭证。不想自建方案页时，直接把用户送到 `createTopupSession` 的托管充值页。

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

选项：`offers`（在售额度包）、`plans`（在售档位）、`creditsPerUnit`、`metric`（计量名，初始版本 `v1`；`billing.setMeter()` 模拟修改计量）、`payments`（false 时充值链接返回 503 `stripe_not_configured`）、`returnOrigin`（允许 `return_path`）、`now`。

档位：免费档按月发放、先用、月底作废，与真服务一致（契约测试覆盖）。订阅是简化模拟：`subscriptionCheckout` 后用 `billing.paySubscription(subscriptionId)` 模拟付款；到期自动续费（已设到期取消的则结束）；用 `now` 选项推进时间。订阅部分不在契约内，跨期、扣款失败、退款等以 Billing 测试环境加 Stripe 测试时钟为准。

假服务只覆盖产品接口，不包括托管充值页、Stripe 和管理端；通过它不代表部署可用。

## 许可

MIT
