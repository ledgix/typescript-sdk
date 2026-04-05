// Ledgix ALCV — TypeScript SDK
// Agent-agnostic compliance shim for SOX 404 policy enforcement
//
// Recommended usage:
//   import { configure, enforce, currentToken } from "ledgix-ts";
//
//   configure({ agentId: "finance-agent" });
//
//   const createPayment = enforce({ toolName: "create_stripe_payment" })(
//     async (amount: number, customerId: string) => {
//       const token = currentToken();
//       // ...
//     }
//   );
//
// Explicit API (advanced):
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
export {
    configure,
    enforce,
    currentClearance,
    currentToken,
    vaultEnforce,
    withVaultContext,
} from "./enforce.js";
export type { EnforceOptions, VaultEnforceOptions, VaultContextOptions } from "./enforce.js";
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
    LedgerEntrySchema,
    LedgerCheckpointSchema,
    LedgerKeyVersionSchema,
    InclusionProofSchema,
    ConsistencyProofSchema,
    LedgerProofBundleSchema,
    LedgerVerificationResultSchema,
    PolicyRegistrationSchema,
    PolicyRegistrationResponseSchema,
    toCamelCaseKeys,
    toSnakeCaseKeys,
} from "./models.js";
export type {
    ClearanceRequest,
    ClearanceResponse,
    LedgerEntry,
    LedgerCheckpoint,
    LedgerManifest,
    LedgerKeyVersion,
    InclusionProof,
    ConsistencyProof,
    LedgerProofBundle,
    LedgerVerificationResult,
    PolicyRegistration,
    PolicyRegistrationResponse,
} from "./models.js";

export const VERSION = "0.1.0";
