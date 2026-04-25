// Ledgix ALCV — LlamaIndex.ts Adapter
// Wraps LlamaIndex tools with Vault clearance enforcement

import type { LedgixClient } from "../client.js";
import type { PendingApproval } from "../pending.js";
import { resolveClient, runGuarded } from "./_core.js";

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
interface WrapToolOptions {
    policyId?: string;
    onReviewPending?: (pending: PendingApproval) => void;
}

export function wrapTool(
    clientOrToolName: LedgixClient | string,
    toolNameOrFn: string | ((args: Record<string, unknown>) => Promise<unknown>),
    toolFnOrOptions?:
        | ((args: Record<string, unknown>) => Promise<unknown>)
        | WrapToolOptions,
    options?: WrapToolOptions,
): (args: Record<string, unknown>) => Promise<unknown> {
    let client: LedgixClient | undefined;
    let toolName: string;
    let toolFn: (args: Record<string, unknown>) => Promise<unknown>;
    let opts: WrapToolOptions | undefined;

    if (typeof clientOrToolName === "string") {
        toolName = clientOrToolName;
        toolFn = toolNameOrFn as (args: Record<string, unknown>) => Promise<unknown>;
        opts = toolFnOrOptions as WrapToolOptions | undefined;
    } else {
        client = clientOrToolName;
        toolName = toolNameOrFn as string;
        toolFn = toolFnOrOptions as (args: Record<string, unknown>) => Promise<unknown>;
        opts = options;
    }

    return async (args: Record<string, unknown>): Promise<unknown> => {
        const resolvedClient = resolveClient(client);
        return runGuarded(resolvedClient, toolName, args, () => toolFn(args), opts);
    };
}
