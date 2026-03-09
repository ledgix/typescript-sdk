// Ledgix ALCV — TypeScript SDK
// Agent-agnostic compliance shim for SOX 404 policy enforcement
//
// Usage:
//   import { LedgixClient, vaultEnforce } from "ledgix-ts";
//
//   const client = new LedgixClient();
//
//   const guardedRefund = vaultEnforce(client, { toolName: "stripe_refund" })(
//     async (amount: number, reason: string, _clearance?) => {
//       const token = _clearance!.token;
//       // ...
//     }
//   );

export { LedgixClient } from "./client.js";
export { createVaultConfig } from "./config.js";
export type { VaultConfig } from "./config.js";
export { vaultEnforce, withVaultContext } from "./enforce.js";
export type { VaultEnforceOptions, VaultContextOptions } from "./enforce.js";
export {
    ClearanceDeniedError,
    ManualReviewTimeoutError,
    PolicyRegistrationError,
    LedgixError,
    TokenVerificationError,
    VaultConnectionError,
} from "./exceptions.js";
export {
    ClearanceRequestSchema,
    ClearanceResponseSchema,
    PolicyRegistrationSchema,
    PolicyRegistrationResponseSchema,
    toCamelCaseKeys,
    toSnakeCaseKeys,
} from "./models.js";
export type {
    ClearanceRequest,
    ClearanceResponse,
    PolicyRegistration,
    PolicyRegistrationResponse,
} from "./models.js";

export const VERSION = "0.1.0";
