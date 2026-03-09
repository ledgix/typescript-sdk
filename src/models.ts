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

// ──────────────────────────────────────────────────────────────────────
// TypeScript Types (inferred from Zod)
// ──────────────────────────────────────────────────────────────────────

export type ClearanceRequest = z.infer<typeof ClearanceRequestSchema>;
export type ClearanceResponse = z.infer<typeof ClearanceResponseSchema>;
export type PolicyRegistration = z.infer<typeof PolicyRegistrationSchema>;
export type PolicyRegistrationResponse = z.infer<typeof PolicyRegistrationResponseSchema>;

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
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
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
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            result[camelKey] = toCamelCaseKeys(value as Record<string, unknown>);
        } else {
            result[camelKey] = value;
        }
    }
    return result;
}
