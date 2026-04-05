// Ledgix ALCV — LlamaIndex.ts Adapter
// Wraps LlamaIndex tools with Vault clearance enforcement

import type { LedgixClient } from "../client.js";
import { _getDefaultClient } from "../enforce.js";
import type { ClearanceRequest } from "../models.js";

/**
 * Wraps a LlamaIndex-style tool function with Vault clearance enforcement.
 *
 * Usage with explicit client:
 * ```ts
 * import { wrapTool } from "ledgix-ts/adapters/llamaindex";
 *
 * const guardedFn = wrapTool(client, "search", mySearchFn, { policyId: "search-policy" });
 * ```
 *
 * Usage after {@link configure}:
 * ```ts
 * const guardedFn = wrapTool("search", mySearchFn, { policyId: "search-policy" });
 * ```
 */
export function wrapTool(
    clientOrToolName: LedgixClient | string,
    toolNameOrFn: string | ((args: Record<string, unknown>) => Promise<unknown>),
    toolFnOrOptions?:
        | ((args: Record<string, unknown>) => Promise<unknown>)
        | { policyId?: string },
    options?: { policyId?: string },
): (args: Record<string, unknown>) => Promise<unknown> {
    let client: LedgixClient | undefined;
    let toolName: string;
    let toolFn: (args: Record<string, unknown>) => Promise<unknown>;
    let opts: { policyId?: string } | undefined;

    if (typeof clientOrToolName === "string") {
        toolName = clientOrToolName;
        toolFn = toolNameOrFn as (args: Record<string, unknown>) => Promise<unknown>;
        opts = toolFnOrOptions as { policyId?: string } | undefined;
    } else {
        client = clientOrToolName;
        toolName = toolNameOrFn as string;
        toolFn = toolFnOrOptions as (args: Record<string, unknown>) => Promise<unknown>;
        opts = options;
    }

    return async (args: Record<string, unknown>): Promise<unknown> => {
        const resolvedClient = client ?? _getDefaultClient();
        const ctx: Record<string, unknown> = {};
        if (opts?.policyId) {
            ctx.policy_id = opts.policyId;
        }

        const request: ClearanceRequest = {
            toolName,
            toolArgs: args,
            agentId: resolvedClient.config.agentId,
            sessionId: resolvedClient.config.sessionId,
            context: ctx,
        };

        // Will throw ClearanceDeniedError if denied
        await resolvedClient.requestClearance(request);
        return toolFn(args);
    };
}
