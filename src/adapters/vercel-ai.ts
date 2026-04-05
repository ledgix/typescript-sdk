// Ledgix ALCV — Vercel AI SDK Adapter
// Wraps Vercel AI SDK tool definitions with Vault clearance enforcement

import type { LedgixClient } from "../client.js";
import { _getDefaultClient } from "../enforce.js";
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
 * Usage with explicit client:
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
 *
 * Usage after {@link configure}:
 * ```ts
 * execute: wrapVercelTool("stripe_refund", async ({ amount }) => { ... }, { policyId: "..." })
 * ```
 */
export function wrapVercelTool<TArgs extends Record<string, unknown>, TResult>(
    clientOrToolName: LedgixClient | string,
    toolNameOrExecute: string | ((args: TArgs) => Promise<TResult>),
    executeOrOptions?: ((args: TArgs) => Promise<TResult>) | WrapVercelToolOptions,
    options?: WrapVercelToolOptions,
): (args: TArgs) => Promise<TResult> {
    let client: LedgixClient | undefined;
    let toolName: string;
    let execute: (args: TArgs) => Promise<TResult>;
    let opts: WrapVercelToolOptions | undefined;

    if (typeof clientOrToolName === "string") {
        toolName = clientOrToolName;
        execute = toolNameOrExecute as (args: TArgs) => Promise<TResult>;
        opts = executeOrOptions as WrapVercelToolOptions | undefined;
    } else {
        client = clientOrToolName;
        toolName = toolNameOrExecute as string;
        execute = executeOrOptions as (args: TArgs) => Promise<TResult>;
        opts = options;
    }

    return async (args: TArgs): Promise<TResult> => {
        const resolvedClient = client ?? _getDefaultClient();
        const ctx: Record<string, unknown> = { ...opts?.context };
        if (opts?.policyId) {
            ctx.policy_id = opts.policyId;
        }

        const request: ClearanceRequest = {
            toolName,
            toolArgs: args as Record<string, unknown>,
            agentId: resolvedClient.config.agentId,
            sessionId: resolvedClient.config.sessionId,
            context: ctx,
        };

        // Will throw ClearanceDeniedError if denied
        await resolvedClient.requestClearance(request);
        return execute(args);
    };
}
