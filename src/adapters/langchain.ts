// Ledgix ALCV — LangChain.js Adapter
// Provides a callback handler and tool wrapper for LangChain integration

import type { LedgixClient } from "../client.js";
import type { ClearanceRequest } from "../models.js";

/**
 * LangChain callback handler that intercepts tool calls for Vault clearance.
 *
 * Usage:
 * ```ts
 * import { LedgixCallbackHandler } from "ledgix-ts/adapters/langchain";
 *
 * const handler = new LedgixCallbackHandler(client);
 * // Use handler.handleToolStart() in your callback chain
 * ```
 */
export class LedgixCallbackHandler {
    private client: LedgixClient;
    private policyId?: string;

    constructor(client: LedgixClient, options?: { policyId?: string }) {
        this.client = client;
        this.policyId = options?.policyId;
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

        const ctx: Record<string, unknown> = {};
        if (this.policyId) {
            ctx.policy_id = this.policyId;
        }

        const request: ClearanceRequest = {
            toolName,
            toolArgs,
            agentId: this.client.config.agentId,
            sessionId: this.client.config.sessionId,
            context: ctx,
        };

        // Will throw ClearanceDeniedError if denied
        await this.client.requestClearance(request);
    }
}

/**
 * Wraps a LangChain tool function with Vault clearance enforcement.
 *
 * Usage:
 * ```ts
 * import { wrapLangChainTool } from "ledgix-ts/adapters/langchain";
 *
 * const guardedTool = wrapLangChainTool(client, "search", originalFn, { policyId: "search-policy" });
 * ```
 */
export function wrapLangChainTool(
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

        await client.requestClearance(request);
        return toolFn(args);
    };
}
