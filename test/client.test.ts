import { expect, test } from "bun:test";
import { BillingError, createBillingClient } from "../src/index";

test("a success whose body is not JSON is an error, not an empty result", async () => {
  const client = createBillingClient({
    baseUrl: "https://billing.test",
    apiKey: "k",
    fetch: (async () =>
      new Response("<html>proxy page</html>", {
        status: 200,
      })) as unknown as typeof fetch,
  });
  const error = await client.balance("u").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(BillingError);
  expect(error).toMatchObject({ status: 200, code: "invalid_response" });
});
