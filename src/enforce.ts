// Ledgix ALCV — Enforcement Layer
// Higher-order function and callback-based context for intercepting tool calls

import { AsyncLocalStorage } from "node:async_hooks";
import { LedgixClient } from "./client.js";
import { createVaultConfig } from "./config.js";
import type { VaultConfig } from "./config.js";
import type { ClearanceRequest, ClearanceResponse } from "./models.js";

// ---------------------------------------------------------------------------
// Global singleton & AsyncLocalStorage
// ---------------------------------------------------------------------------

let _defaultClient: LedgixClient | null = null;
const _clearanceStorage = new AsyncLocalStorage<ClearanceResponse>();

/**
 * Configure the global Ledgix client.
 *
 * Call this once at application startup. All subsequent calls to
 * {@link enforce} will use this client automatically.
 *
 * ```ts
 * import { configure, enforce, currentToken } from "ledgix-ts";
 *
 * configure({ agentId: "finance-agent" });
 * ```
 *
 * @param clientOrOptions - Either a pre-built {@link LedgixClient} instance or
 *   partial config options (merged with environment variables and defaults).
 */
export function configure(
    clientOrOptions: LedgixClient | Partial<VaultConfig>,
): LedgixClient {
    if (clientOrOptions instanceof LedgixClient) {
        _defaultClient = clientOrOptions;
    } else {
        const config = createVaultConfig(clientOrOptions as Partial<VaultConfig>);
        _defaultClient = new LedgixClient(config);
    }
    return _defaultClient;
}

/**
 * Return the global client, throwing if {@link configure} was never called.
 * @internal
 */
export function _getDefaultClient(): LedgixClient {
    if (_defaultClient === null) {
        throw new Error(
            "No Ledgix client configured. Call configure() at startup before using enforce().",
        );
    }
    return _defaultClient;
}

/**
 * Return the {@link ClearanceResponse} for the current async call context.
 *
 * Returns `undefined` when called outside an {@link enforce}-wrapped function.
 */
export function currentClearance(): ClearanceResponse | undefined {
    return _clearanceStorage.getStore();
}

/**
 * Return the A-JWT token for the current async call context.
 *
 * Returns `undefined` when called outside an {@link enforce}-wrapped function
 * or when the clearance did not include a token.
 */
export function currentToken(): string | undefined {
    return _clearanceStorage.getStore()?.token;
}

// ---------------------------------------------------------------------------
// New low-code HOF: enforce()
// ---------------------------------------------------------------------------

/**
 * Options for the {@link enforce} higher-order function.
 */
export interface EnforceOptions {
    /** Explicit tool name. Defaults to the wrapped function's name. */
    toolName?: string;
    /** Policy ID to include in the clearance context. */
    policyId?: string;
    /** Additional context for the clearance request. */
    context?: Record<string, unknown>;
    /**
     * Custom argument extractor. Use when default introspection is unreliable
     * (e.g. minified bundles).
     */
    argsExtractor?: (args: unknown[]) => Record<string, unknown>;
}

/**
 * Higher-order function that enforces Vault clearance before a function executes.
 *
 * Requires {@link configure} to have been called at startup. The A-JWT token
 * is available inside the wrapped function via {@link currentToken} — no
 * parameter injection, no signature changes needed.
 *
 * ```ts
 * import { configure, enforce, currentToken } from "ledgix-ts";
 *
 * configure({ agentId: "finance-agent" });
 *
 * const createPayment = enforce({ toolName: "create_stripe_payment" })(
 *   async (amount: number, customerId: string) => {
 *     const token = currentToken();
 *     return stripe.paymentIntents.create({ amount, customer: customerId,
 *       metadata: { vault_token: token } });
 *   }
 * );
 * ```
 */
export function enforce(
    options?: EnforceOptions,
): <TArgs extends unknown[], TReturn>(
    fn: (...args: TArgs) => Promise<TReturn>,
) => (...args: TArgs) => Promise<TReturn> {
    return <TArgs extends unknown[], TReturn>(
        fn: (...args: TArgs) => Promise<TReturn>,
    ) => {
        const resolvedName = options?.toolName ?? fn.name ?? "unknown_tool";

        const wrapper = async (...args: TArgs): Promise<TReturn> => {
            const client = _getDefaultClient();
            const toolArgs = options?.argsExtractor
                ? options.argsExtractor([...args])
                : _extractToolArgs(fn, args);
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

            // Run fn inside AsyncLocalStorage context so currentToken() works
            return _clearanceStorage.run(clearance, () => fn(...args));
        };

        Object.defineProperty(wrapper, "name", { value: fn.name, configurable: true });

        return wrapper;
    };
}

// ---------------------------------------------------------------------------
// Original explicit HOF: vaultEnforce()  (unchanged)
// ---------------------------------------------------------------------------

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
    /**
     * Custom argument extractor for populating `toolArgs` from the function's
     * positional arguments. Use this when the default introspection-based
     * extraction is unreliable — for example in minified bundles where
     * parameter names are mangled.
     *
     * @param args - The positional arguments passed to the wrapped function.
     * @returns A plain object mapping argument names to values.
     */
    argsExtractor?: (args: unknown[]) => Record<string, unknown>;
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
 *
 * @deprecated Prefer {@link enforce} for new code — it requires no changes to
 * the function signature and uses the global client set by {@link configure}.
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
            const toolArgs = options?.argsExtractor
                ? options.argsExtractor([...args])
                : _extractToolArgs(fn, args);
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
 * Best-effort extraction of named function parameters for the clearance request.
 *
 * Handles regular functions, async functions, and arrow functions (both parens
 * and single-param shorthand). Skips rest params (`...x`), destructured params
 * (`{ a, b }`), and private params (prefixed with `_`).
 *
 * Note: relies on non-minified source. For minified builds, supply an explicit
 * `argsExtractor` via {@link VaultEnforceOptions}.
 */
function _extractToolArgs(fn: Function, args: unknown[]): Record<string, unknown> {
    try {
        const fnStr = fn.toString();

        // Match parameter list from various syntaxes:
        //   function name(a, b)  /  async function(a, b)  /  (a, b) =>  /  async (a, b) =>
        const withParens = fnStr.match(/^[^(]*\(([^)]*)\)/);
        //   Single-param arrow without parens:  a =>  /  async a =>
        const withoutParens = fnStr.match(/^(?:async\s+)?(\w+)\s*=>/);

        const paramsStr = withParens?.[1] ?? withoutParens?.[1] ?? null;
        if (paramsStr === null || paramsStr.trim() === "") return {};

        const params = paramsStr
            .split(",")
            .map((p) => p.trim())
            .filter((p) => p && !p.startsWith("...") && !p.startsWith("{"));

        const result: Record<string, unknown> = {};
        for (let i = 0; i < Math.min(params.length, args.length); i++) {
            // Strip TS type annotation, optional marker, and default value
            const paramName = params[i].split(":")[0].split("?")[0].split("=")[0].trim();
            if (paramName && !paramName.startsWith("_")) {
                result[paramName] = args[i];
            }
        }
        return result;
    } catch {
        return {};
    }
}
