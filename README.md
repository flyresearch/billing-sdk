# @flyresearch/billing-sdk

Billing 产品接口（API v1）的客户端，以及给产品自己写测试用的内存 Billing。

- `@flyresearch/billing-sdk`：零依赖、只用 `fetch` 的客户端，加上 `chargedRun` / `recoverCharge`（冻结 → 执行 → 结算的正确顺序与崩溃恢复）和充值辅助。Node 18+、Bun、Deno、Cloudflare Workers 都能用。
- `@flyresearch/billing-sdk/testing`：内存假服务。按公开接口的规则行为，会像生产一样拒绝额度不足、同键不同参数、超出冻结上限或授权期的结算。
- `@flyresearch/billing-sdk/contract`：契约测试。同一套测试在这里对假服务跑，在 Billing 服务仓库里对真服务跑，保证两者一致。

完整接入步骤见 Billing 服务自带的 `/docs/quickstart.html`。

## 安装

```sh
bun add github:flyresearch/billing-sdk#v0.1.0
```

源码是 TypeScript，直接被 Bun、Deno 和 Workers 的打包器使用。

## 使用

```ts
import { createBillingClient, chargedRun } from "@flyresearch/billing-sdk";

const billing = createBillingClient({ baseUrl, apiKey }); // product.json 里的 base_url / api_key
const { url } = await billing.createTopupSession(userId, {
  return_path: "/billing/done",
});
const { available } = await billing.balance(userId);
const outcome = await chargedRun(
  billing,
  store,
  input,
  async ({ work_until }) => {
    // 真实业务；返回可信的实际用量
    return { units: "37", result };
  },
);
```

`store` 是你数据库里的五个操作（`ChargeStore`），用自己的事务实现。

## 测试

```ts
import { createBillingClient } from "@flyresearch/billing-sdk";
import { createTestBilling } from "@flyresearch/billing-sdk/testing";

const billing = await createTestBilling();
const client = createBillingClient({ ...billing.config, fetch: billing.fetch });
billing.grant("user_1", "1000"); // 测试额度
await billing.pay(orderId); // 模拟付款完成
```

选项：`config`（计量合同）、`offers`（在售额度包）、`returnOrigin`（允许 `return_path`）、`now`（可控时钟，用来测冻结过期）。

假服务只覆盖产品凭据能调用的接口，不包括管理端、退款、自定金额额度包和账户关闭；通过它不代表部署可用。

## 许可

MIT
