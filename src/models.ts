// Ledgix ALCV — Data Models
// Zod schemas for Vault API request/response payloads
// Wire format (Vault API) uses snake_case; SDK uses camelCase

import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────
// Zod Schemas
// ──────────────────────────────────────────────────────────────────────

/** Schema for the clearance request sent to the Vault. */
export const ClearanceRequestSchema = z.object({
    toolName: z.string().describe("Name of the tool the agent wants to invoke"),
    toolArgs: z
        .record(z.unknown())
        .default({})
        .describe("Arguments the agent will pass to the tool"),
    agentId: z.string().default("default-agent").describe("Identifier for the calling agent"),
    sessionId: z.string().default("").describe("Session grouping identifier"),
    context: z
        .record(z.unknown())
        .default({})
        .describe("Additional context for the Vault's policy judge"),
});

/** Schema for the clearance response from the Vault. */
const ClearanceStatusSchema = z
    .enum(["processing", "approved", "denied", "pending_review", "pendingReview"])
    .transform((value) => (value === "pending_review" ? "pendingReview" : value));

export const ClearanceResponseSchema = z.object({
    status: ClearanceStatusSchema.default("denied").describe("Decision state"),
    approved: z.boolean().describe("Whether the tool call was approved"),
    requiresManualReview: z.boolean().default(false).describe("Whether manual review is required"),
    token: z.string().nullable().default(null).describe("Signed A-JWT if approved, null if denied"),
    reason: z.string().default("").describe("Human-readable explanation of the decision"),
    requestId: z.string().default("").describe("Vault-assigned unique ID for this request"),
    confidence: z.number().min(0).max(1).default(0).describe("Judge confidence score"),
    minimumConfidenceScore: z.number().min(0).max(1).default(0).describe("Client minimum confidence score"),
});

/** Schema for policy registration payload. */
export const PolicyRegistrationSchema = z.object({
    policyId: z.string().describe("Unique identifier for the policy"),
    description: z.string().default("").describe("Human-readable description of the policy"),
    rules: z
        .array(z.string())
        .default([])
        .describe("List of plain-English rules"),
    tools: z
        .array(z.string())
        .default([])
        .describe("Tool names this policy applies to (empty = all tools)"),
});

/** Schema for policy registration response. */
export const PolicyRegistrationResponseSchema = z.object({
    policyId: z.string().describe("Confirmed policy ID"),
    status: z.string().default("registered").describe("Registration status"),
    message: z.string().default("").describe("Additional information"),
});

export const LedgerEntrySchema = z.object({
    seq: z.number(),
    eventUuid: z.string(),
    requestId: z.string(),
    agentId: z.string(),
    policyId: z.string(),
    intentHash: z.string().default(""),
    toolName: z.string(),
    toolArgs: z.record(z.unknown()).default({}),
    reason: z.string().default(""),
    citations: z.array(z.record(z.unknown())).default([]),
    evidenceChunks: z.array(z.record(z.unknown())).default([]),
    confidence: z.number().default(0),
    approved: z.boolean(),
    acceptedAt: z.string(),
    canonicalVersion: z.number().int().default(1),
    eventHash: z.string(),
    leafHash: z.string(),
    leafIndex: z.number().nullable().optional(),
    checkpointId: z.number().nullable().optional(),
    receiptAlgorithm: z.string().default(""),
    receiptKeyId: z.string().default(""),
    receiptSignature: z.string().default(""),
    receiptPayload: z.string().default(""),
});

export const LedgerCheckpointSchema = z.object({
    checkpointId: z.number(),
    microblockId: z.number(),
    treeSize: z.number(),
    rootHash: z.string(),
    checkpointHash: z.string(),
    prevCheckpointHash: z.string().default(""),
    signatureAlgorithm: z.string().default(""),
    signerKeyId: z.string().default(""),
    checkpointSignature: z.string().default(""),
    checkpointPayload: z.string().default(""),
    signedAt: z.string(),
    mmdSeconds: z.number().int().default(30),
    exportTarget: z.string().default(""),
    exportUri: z.string().default(""),
    exportStatus: z.string().default(""),
    exportedAt: z.string().optional(),
});

export const LedgerKeyVersionSchema = z.object({
    keyId: z.string(),
    algorithm: z.string(),
    publicJwk: z.string().default(""),
    activeFrom: z.string(),
    retiredAt: z.string().optional(),
    attestationPayload: z.string().default(""),
    attestationSignature: z.string().default(""),
    attestationKeyId: z.string().default(""),
    attestationStatus: z.string().default(""),
});

export const InclusionProofSchema = z.object({
    eventUuid: z.string(),
    requestId: z.string(),
    eventHash: z.string(),
    leafHash: z.string(),
    leafIndex: z.number(),
    treeSize: z.number(),
    path: z.array(z.string()).default([]),
    checkpoint: LedgerCheckpointSchema,
});

export const ConsistencyProofSchema = z.object({
    fromCheckpoint: LedgerCheckpointSchema,
    toCheckpoint: LedgerCheckpointSchema,
    path: z.array(z.string()).default([]),
});

export const LedgerProofBundleSchema = z.object({
    event: LedgerEntrySchema,
    inclusion: InclusionProofSchema,
    consistency: ConsistencyProofSchema.optional(),
    keys: z.array(LedgerKeyVersionSchema).default([]),
});

export const LedgerVerificationResultSchema = z.object({
    intact: z.boolean(),
    verifiedEntries: z.number().int().nonnegative(),
    verifiedCheckpoints: z.number().int().nonnegative().default(0),
    verifiedManifests: z.number().int().nonnegative().default(0),
    latestLeafHash: z.string().nullable().default(null),
    latestCheckpointHash: z.string().nullable().default(null),
    latestManifestHash: z.string().nullable().default(null),
    coverageNote: z.string().optional(),
    error: z.string().optional(),
});

// ──────────────────────────────────────────────────────────────────────
// TypeScript Types (inferred from Zod)
// ──────────────────────────────────────────────────────────────────────

export type ClearanceRequest = z.infer<typeof ClearanceRequestSchema>;
export type ClearanceResponse = z.infer<typeof ClearanceResponseSchema>;
export type PolicyRegistration = z.infer<typeof PolicyRegistrationSchema>;
export type PolicyRegistrationResponse = z.infer<typeof PolicyRegistrationResponseSchema>;
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
export type LedgerCheckpoint = z.infer<typeof LedgerCheckpointSchema>;
export type LedgerManifest = LedgerCheckpoint;
export type LedgerKeyVersion = z.infer<typeof LedgerKeyVersionSchema>;
export type InclusionProof = z.infer<typeof InclusionProofSchema>;
export type ConsistencyProof = z.infer<typeof ConsistencyProofSchema>;
export type LedgerProofBundle = z.infer<typeof LedgerProofBundleSchema>;
export type LedgerVerificationResult = z.infer<typeof LedgerVerificationResultSchema>;

// ──────────────────────────────────────────────────────────────────────
// Case Conversion Utilities
// ──────────────────────────────────────────────────────────────────────

/** Convert a camelCase string to snake_case. */
function camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Convert a snake_case string to camelCase. */
function snakeToCamel(str: string): string {
    return str.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Recursively convert all keys in an object from camelCase to snake_case.
 * Used when serializing requests for the Vault API.
 */
export function toSnakeCaseKeys(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        const snakeKey = camelToSnake(key);
        if (Array.isArray(value)) {
            result[snakeKey] = value.map((item) =>
                item !== null && typeof item === "object" && !Array.isArray(item)
                    ? toSnakeCaseKeys(item as Record<string, unknown>)
                    : item,
            );
        } else if (value !== null && typeof value === "object") {
            result[snakeKey] = toSnakeCaseKeys(value as Record<string, unknown>);
        } else {
            result[snakeKey] = value;
        }
    }
    return result;
}

/**
 * Recursively convert all keys in an object from snake_case to camelCase.
 * Used when parsing responses from the Vault API.
 */
export function toCamelCaseKeys(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        const camelKey = snakeToCamel(key);
        if (Array.isArray(value)) {
            result[camelKey] = value.map((item) =>
                item !== null && typeof item === "object" && !Array.isArray(item)
                    ? toCamelCaseKeys(item as Record<string, unknown>)
                    : item,
            );
        } else if (value !== null && typeof value === "object") {
            result[camelKey] = toCamelCaseKeys(value as Record<string, unknown>);
        } else {
            result[camelKey] = value;
        }
    }
    return result;
}
