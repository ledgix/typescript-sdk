// Ledgix ALCV — TypeScript SDK
// Agent-agnostic compliance shim for SOX 404 policy enforcement
//
// Recommended usage:
//   import * as rawTools from "./tools.js";
//   import { configure, autoInstrument } from "ledgix-ts";
//
//   configure({ agentId: "finance-agent" });
//
//   const tools = autoInstrument(rawTools);
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
    autoInstrument,
    tool,
    currentClearance,
    currentToken,
    vaultEnforce,
    withVaultContext,
} from "./enforce.js";
export type { EnforceOptions, VaultEnforceOptions, VaultContextOptions } from "./enforce.js";
export { Manifest, loadManifest, _globMatch } from "./manifest.js";
export type { ManifestRule, ManifestSchema } from "./manifest.js";
export {
    ClearanceDeniedError,
    ManualReviewTimeoutError,
    PolicyRegistrationError,
    LedgixError,
    QueueSaturatedError,
    ReplayDetectedError,
    ReviewPendingError,
    TokenVerificationError,
    VaultConnectionError,
} from "./exceptions.js";
export { PendingApproval } from "./pending.js";
export { extractCounterparty } from "./counterparty.js";
export type { CounterpartyHint } from "./counterparty.js";
export { verifyWebhook } from "./webhook.js";
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

export const VERSION = "0.3.0";
