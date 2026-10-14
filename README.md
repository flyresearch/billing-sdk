# @flyresearch/billing-sdk

Billing 产品接口（API v1）的客户端，以及给产品自己写测试用的内存 Billing。

模型是**先用后报**：开始工作前读一次余额，执行中按间隔上报已经发生的用量，余额用尽时 Billing 告诉你停下。超支最多一个上报间隔，下一次充值先抵扣。

- `@flyresearch/billing-sdk`：零依赖、只用 `fetch` 的客户端和 `createMeter`。Node 18+、Bun、Deno、Cloudflare Workers 都能用。
- `@flyresearch/billing-sdk/testing`：内存假服务，按公开接口的规则行为。
- `@flyresearch/billing-sdk/contract`：契约测试。同一套测试在这里对假服务跑，在 Billing 服务仓库里对真服务跑，保证两者一致。

## 安装

```sh
bun add github:flyresearch/billing-sdk#v0.2.0
```

源码是 TypeScript，直接被 Bun、Deno 和 Workers 的打包器使用。`v0.1.x` 是旧接口（冻结与结算），与 `v0.2` 不兼容。

## 四个接口

| 方法 | 作用 |
|---|---|
| `balance(customer)` | `{ balance, allowed }`；`allowed` 为 false 就不开始 |
| `reportUsage(customer, { event_id, units, metadata? })` | 上报已发生的用量。`event_id` 即幂等键，重发不重复扣费 |
| `createTopupSession(customer, { return_path? })` | 托管充值页链接（30 分钟有效），把用户浏览器送过去 |
| `history(customer, { cursor?, type? })` | 充值、用量、退款、调账记录 |

客户 ID 由你的产品定义，第一次出现时自动建立。金额和额度都是十进制整数字符串。

## 用法

```ts
import { createBillingClient, createMeter } from "@flyresearch/billing-sdk";

const billing = createBillingClient({ baseUrl, apiKey }); // 控制台签发的产品密钥

// 开始前
if (!(await billing.balance(userId)).allowed) return showTopUp(await billing.createTopupSession(userId));

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

## 测试

```ts
import { createBillingClient } from "@flyresearch/billing-sdk";
import { createTestBilling } from "@flyresearch/billing-sdk/testing";

const billing = await createTestBilling({ creditsPerUnit: 1 });
const client = createBillingClient({ ...billing.config, fetch: billing.fetch });
await billing.grant("user_1", "1000"); // 测试额度
await billing.purchase("user_1", "5000"); // 模拟一次已付款的充值
```

选项：`creditsPerUnit`、`payments`（false 时充值链接返回 `payments_not_configured`）、`returnOrigin`（允许 `return_path`）、`now`。

假服务只覆盖产品接口，不包括托管充值页、Stripe 和管理端；通过它不代表部署可用。

## 许可

MIT
