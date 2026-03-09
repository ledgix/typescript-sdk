// Ledgix ALCV — LlamaIndex.ts Adapter
// Wraps LlamaIndex tools with Vault clearance enforcement

import type { LedgixClient } from "../client.js";
import type { ClearanceRequest } from "../models.js";

/**
 * Wraps a LlamaIndex-style tool function with Vault clearance enforcement.
 *
 * Since LlamaIndex.ts has a different API surface than the Python version,
 * this adapter wraps the underlying function rather than the FunctionTool class.
 *
 * Usage:
 * ```ts
 * import { wrapTool } from "ledgix-ts/adapters/llamaindex";
 *
 * const guardedFn = wrapTool(client, "search", mySearchFn, { policyId: "search-policy" });
 * ```
 */
export function wrapTool(
    client: LedgixClient,
    toolName: string,
    toolFn: (args: Record<string, unknown>) => Promise<unknown>,
    options?: { policyId?: string },
): (args: Record<string, unknown>) => Promise<unknown> {
    return async (args: Record<string, unknown>): Promise<unknown> => {
        const ctx: Record<string, unknown> = {};
        if (options?.policyId) {
            ctx.policy_id = options.policyId;
        }

        const request: ClearanceRequest = {
            toolName,
            toolArgs: args,
            agentId: client.config.agentId,
            sessionId: client.config.sessionId,
            context: ctx,
        };

        // Will throw ClearanceDeniedError if denied
        await client.requestClearance(request);
        return toolFn(args);
    };
}
