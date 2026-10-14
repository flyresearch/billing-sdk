import { contractSuite } from "../src/contract";
import { createTestBilling } from "../src/testing";

contractSuite("in-memory test Billing", createTestBilling);
