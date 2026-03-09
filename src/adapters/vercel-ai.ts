// Ledgix ALCV — Vercel AI SDK Adapter
// Wraps Vercel AI SDK tool definitions with Vault clearance enforcement

import type { LedgixClient } from "../client.js";
import type { ClearanceRequest } from "../models.js";

/**
 * Options for wrapping a Vercel AI SDK tool.
 */
export interface WrapVercelToolOptions {
    /** Policy ID to include in the clearance context. */
    policyId?: string;
    /** Additional context for the clearance request. */
    context?: Record<string, unknown>;
}

/**
 * Wraps a Vercel AI SDK tool's execute function with Vault clearance enforcement.
 *
 * Usage:
 * ```ts
 * import { wrapVercelTool } from "ledgix-ts/adapters/vercel-ai";
 * import { tool } from "ai";
 * import { z } from "zod";
 *
 * const refundTool = tool({
 *   description: "Process a refund",
 *   parameters: z.object({ amount: z.number(), reason: z.string() }),
 *   execute: wrapVercelTool(client, "stripe_refund", async ({ amount, reason }) => {
 *     return { refunded: amount, reason };
 *   }),
 * });
 * ```
 */
export function wrapVercelTool<TArgs extends Record<string, unknown>, TResult>(
    client: LedgixClient,
    toolName: string,
    execute: (args: TArgs) => Promise<TResult>,
    options?: WrapVercelToolOptions,
): (args: TArgs) => Promise<TResult> {
    return async (args: TArgs): Promise<TResult> => {
        const ctx: Record<string, unknown> = { ...options?.context };
        if (options?.policyId) {
            ctx.policy_id = options.policyId;
        }

        const request: ClearanceRequest = {
            toolName,
            toolArgs: args as Record<string, unknown>,
            agentId: client.config.agentId,
            sessionId: client.config.sessionId,
            context: ctx,
        };

        // Will throw ClearanceDeniedError if denied
        await client.requestClearance(request);
        return execute(args);
    };
}
