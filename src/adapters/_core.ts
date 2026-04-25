// Ledgix ALCV — Adapter Core Helpers
// Shared scaffolding used by the LangChain, LlamaIndex, and Vercel AI adapters.
// Framework-specific glue (handlers, error translation, generic typing)
// stays per-adapter.

import type { LedgixClient } from "../client.js";
import { _getDefaultClient } from "../enforce.js";
import { ReviewPendingError } from "../exceptions.js";
import type { ClearanceRequest } from "../models.js";
import type { PendingApproval } from "../pending.js";

export interface BuildRequestOptions {
    policyId?: string;
    extraContext?: Record<string, unknown>;
}

export function resolveClient(client?: LedgixClient): LedgixClient {
    return client ?? _getDefaultClient();
}

export function buildClearanceRequest(
    client: LedgixClient,
    toolName: string,
    toolArgs: Record<string, unknown>,
    opts?: BuildRequestOptions,
): ClearanceRequest {
    const context: Record<string, unknown> = { ...(opts?.extraContext ?? {}) };
    if (opts?.policyId) {
        context.policy_id = opts.policyId;
    }
    return {
        toolName,
        toolArgs,
        agentId: client.config.agentId,
        sessionId: client.config.sessionId,
        context,
    };
}

export interface RunGuardedOptions extends BuildRequestOptions {
    onReviewPending?: (pending: PendingApproval) => void;
}

/**
 * Request clearance, then call `fn`. If the Vault returns pending_review and
 * the caller supplied `onReviewPending`, fire the callback before re-throwing
 * (preserves the existing behavior of every adapter).
 */
export async function runGuarded<T>(
    client: LedgixClient,
    toolName: string,
    toolArgs: Record<string, unknown>,
    fn: () => Promise<T>,
    opts?: RunGuardedOptions,
): Promise<T> {
    const req = buildClearanceRequest(client, toolName, toolArgs, opts);
    try {
        await client.requestClearance(req);
    } catch (err) {
        if (err instanceof ReviewPendingError && opts?.onReviewPending) {
            opts.onReviewPending(err.pendingApproval as PendingApproval);
        }
        throw err;
    }
    return fn();
}
