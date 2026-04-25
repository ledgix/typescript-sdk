// Ledgix ALCV — LangChain.js Adapter
// Provides a callback handler and tool wrapper for LangChain integration

import type { LedgixClient } from "../client.js";
import { ReviewPendingError } from "../exceptions.js";
import type { PendingApproval } from "../pending.js";
import { buildClearanceRequest, resolveClient, runGuarded } from "./_core.js";

/**
 * LangChain callback handler that intercepts tool calls for Vault clearance.
 *
 * Usage with explicit client:
 * ```ts
 * import { LedgixCallbackHandler } from "ledgix-ts/adapters/langchain";
 *
 * const handler = new LedgixCallbackHandler(client);
 * ```
 *
 * Usage after {@link configure}:
 * ```ts
 * const handler = new LedgixCallbackHandler();
 * ```
 */
export class LedgixCallbackHandler {
    private _client?: LedgixClient;
    private policyId?: string;
    private onReviewPending?: (pending: PendingApproval) => void;

    constructor(
        client?: LedgixClient,
        options?: { policyId?: string; onReviewPending?: (pending: PendingApproval) => void },
    ) {
        this._client = client;
        this.policyId = options?.policyId;
        this.onReviewPending = options?.onReviewPending;
    }

    private get client(): LedgixClient {
        return resolveClient(this._client);
    }

    async handleToolStart(
        tool: { name?: string },
        input: string,
        _runId?: string,
        _parentRunId?: string,
        _tags?: string[],
        _metadata?: Record<string, unknown>,
        inputs?: Record<string, unknown>,
    ): Promise<void> {
        const toolName = tool.name ?? "unknown_tool";
        const toolArgs = inputs ?? { input };

        const request = buildClearanceRequest(this.client, toolName, toolArgs, {
            policyId: this.policyId,
        });

        try {
            await this.client.requestClearance(request);
        } catch (err) {
            if (err instanceof ReviewPendingError && this.onReviewPending) {
                this.onReviewPending(err.pendingApproval as PendingApproval);
            }
            throw err;
        }
    }
}

/**
 * Wraps a LangChain tool function with Vault clearance enforcement.
 *
 * Usage with explicit client:
 * ```ts
 * import { wrapLangChainTool } from "ledgix-ts/adapters/langchain";
 *
 * const guardedTool = wrapLangChainTool(client, "search", originalFn, { policyId: "search-policy" });
 * ```
 *
 * Usage after {@link configure}:
 * ```ts
 * const guardedTool = wrapLangChainTool("search", originalFn, { policyId: "search-policy" });
 * ```
 */
interface WrapLangChainToolOptions {
    policyId?: string;
    onReviewPending?: (pending: PendingApproval) => void;
}

export function wrapLangChainTool(
    clientOrToolName: LedgixClient | string,
    toolNameOrFn: string | ((args: Record<string, unknown>) => Promise<unknown>),
    toolFnOrOptions?:
        | ((args: Record<string, unknown>) => Promise<unknown>)
        | WrapLangChainToolOptions,
    options?: WrapLangChainToolOptions,
): (args: Record<string, unknown>) => Promise<unknown> {
    let client: LedgixClient | undefined;
    let toolName: string;
    let toolFn: (args: Record<string, unknown>) => Promise<unknown>;
    let opts: WrapLangChainToolOptions | undefined;

    if (typeof clientOrToolName === "string") {
        toolName = clientOrToolName;
        toolFn = toolNameOrFn as (args: Record<string, unknown>) => Promise<unknown>;
        opts = toolFnOrOptions as WrapLangChainToolOptions | undefined;
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
