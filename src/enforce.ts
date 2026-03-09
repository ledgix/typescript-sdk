// Ledgix ALCV — Enforcement Layer
// Higher-order function and callback-based context for intercepting tool calls

import type { LedgixClient } from "./client.js";
import type { ClearanceRequest, ClearanceResponse } from "./models.js";

/**
 * Options for the `vaultEnforce` higher-order function.
 */
export interface VaultEnforceOptions {
    /** Explicit tool name. Defaults to the wrapped function's name. */
    toolName?: string;
    /** Policy ID to include in the clearance context. */
    policyId?: string;
    /** Additional context for the clearance request. */
    context?: Record<string, unknown>;
}

/**
 * Higher-order function that enforces Vault clearance before a function executes.
 *
 * Usage:
 * ```ts
 * const guardedRefund = vaultEnforce(client, { toolName: "stripe_refund" })(
 *   async (amount: number, reason: string, _clearance?: ClearanceResponse) => {
 *     // _clearance is injected as the last argument
 *     return stripe.refund({ amount, metadata: { vault_token: _clearance!.token } });
 *   }
 * );
 *
 * await guardedRefund(45, "late package");
 * ```
 */
export function vaultEnforce(
    client: LedgixClient,
    options?: VaultEnforceOptions,
): <TArgs extends unknown[], TReturn>(
    fn: (...args: [...TArgs, ClearanceResponse?]) => Promise<TReturn>,
) => (...args: TArgs) => Promise<TReturn> {
    return <TArgs extends unknown[], TReturn>(
        fn: (...args: [...TArgs, ClearanceResponse?]) => Promise<TReturn>,
    ) => {
        const resolvedName = options?.toolName ?? fn.name ?? "unknown_tool";

        const wrapper = async (...args: TArgs): Promise<TReturn> => {
            const toolArgs = _extractToolArgs(fn, args);
            const ctx: Record<string, unknown> = { ...options?.context };
            if (options?.policyId) {
                ctx.policy_id = options.policyId;
            }

            const request: ClearanceRequest = {
                toolName: resolvedName,
                toolArgs,
                agentId: client.config.agentId,
                sessionId: client.config.sessionId,
                context: ctx,
            };

            const clearance = await client.requestClearance(request);

            // Inject clearance as the last argument
            return fn(...args, clearance);
        };

        // Preserve function name for debugging
        Object.defineProperty(wrapper, "name", { value: fn.name, configurable: true });

        return wrapper;
    };
}

/**
 * Options for the `withVaultContext` callback pattern.
 */
export interface VaultContextOptions {
    /** Policy ID to include in the clearance context. */
    policyId?: string;
    /** Additional context for the clearance request. */
    context?: Record<string, unknown>;
}

/**
 * Callback-based pattern for Vault clearance (replaces Python's `with VaultContext(...)` context manager).
 *
 * Usage:
 * ```ts
 * const result = await withVaultContext(
 *   client,
 *   "stripe_refund",
 *   { amount: 45, reason: "Late package" },
 *   {},
 *   async (clearance) => {
 *     return executeRefund(clearance.token);
 *   },
 * );
 * ```
 */
export async function withVaultContext<T>(
    client: LedgixClient,
    toolName: string,
    toolArgs: Record<string, unknown>,
    options: VaultContextOptions,
    fn: (clearance: ClearanceResponse) => Promise<T>,
): Promise<T> {
    const ctx: Record<string, unknown> = { ...options.context };
    if (options.policyId) {
        ctx.policy_id = options.policyId;
    }

    const request: ClearanceRequest = {
        toolName,
        toolArgs,
        agentId: client.config.agentId,
        sessionId: client.config.sessionId,
        context: ctx,
    };

    const clearance = await client.requestClearance(request);
    return fn(clearance);
}

/**
 * Best-effort extraction of function arguments as a dict for the clearance request.
 */
function _extractToolArgs(fn: Function, args: unknown[]): Record<string, unknown> {
    try {
        // Parse function parameter names from the function's string representation
        const fnStr = fn.toString();
        const paramMatch = fnStr.match(/\(([^)]*)\)/);
        if (!paramMatch) return {};

        const params = paramMatch[1]
            .split(",")
            .map((p) => p.trim())
            .filter((p) => p && !p.startsWith("_") && !p.startsWith("..."));

        const result: Record<string, unknown> = {};
        for (let i = 0; i < Math.min(params.length, args.length); i++) {
            // Remove type annotations and default values for the param name
            const paramName = params[i].split(":")[0].split("=")[0].split("?")[0].trim();
            if (paramName && !paramName.startsWith("_")) {
                result[paramName] = args[i];
            }
        }
        return result;
    } catch {
        return {};
    }
}
