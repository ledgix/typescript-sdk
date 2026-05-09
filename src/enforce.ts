// Ledgix ALCV — Enforcement Layer
// Higher-order function and callback-based context for intercepting tool calls

import { AsyncLocalStorage } from "node:async_hooks";
import { LedgixClient } from "./client.js";
import { createVaultConfig } from "./config.js";
import type { VaultConfig } from "./config.js";
import { Manifest, loadManifest } from "./manifest.js";
import type { ManifestRule, ManifestSchema } from "./manifest.js";
import type { ClearanceRequest, ClearanceResponse } from "./models.js";

// ---------------------------------------------------------------------------
// Global singleton & AsyncLocalStorage
// ---------------------------------------------------------------------------

let _defaultClient: LedgixClient | null = null;
const _clearanceStorage = new AsyncLocalStorage<ClearanceResponse>();
let _manifest: Manifest | null = null;

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
    return _clearanceStorage.getStore()?.token ?? undefined;
}

// ---------------------------------------------------------------------------
// Manifest-driven auto-instrumentation
// ---------------------------------------------------------------------------

/**
 * Wrap all matching functions in *fns* according to a manifest and return a
 * new object with the same shape but with enforcement applied.
 *
 * Call once at startup after {@link configure}:
 *
 * ```ts
 * import * as tools from "./tools.js";
 * import { configure, autoInstrument } from "ledgix-ts";
 *
 * configure({ agentId: "my-agent" });
 * const { stripePayment, issueRefund } = autoInstrument(tools);
 * ```
 *
 * By default reads `ledgix.json` from the current working directory:
 *
 * ```json
 * {
 *   "enforce": [
 *     { "tool": "stripe*",  "policyId": "financial-high-risk" },
 *     { "tool": "dbWrite*", "policyId": "data-mutation" }
 *   ]
 * }
 * ```
 *
 * Non-function values and functions with no matching rule are passed through
 * unchanged.
 *
 * @param fns - Plain object of functions (e.g. `import * as tools from …`).
 * @param manifest - Optional manifest path, inline object, or pre-built
 *   {@link Manifest}. Defaults to `ledgix.json` in the current working
 *   directory.
 * @returns New object with matched functions replaced by enforced wrappers.
 */
export function autoInstrument<T extends Record<string, unknown>>(
    fns: T,
    manifest?: string | ManifestSchema | Manifest,
): T {
    // ship-safe-ignore AGENT_MANIFEST_NO_SIGNATURE — manifest is loaded from local filesystem, not downloaded
    _manifest = loadManifest(manifest);

    const result: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(fns)) {
        if (typeof value !== "function") {
            result[name] = value;
            continue;
        }
        const rule = _manifest.match(name);
        if (rule == null) {
            result[name] = value;
            continue;
        }
        result[name] = _wrapWithRule(
            value as (...args: unknown[]) => Promise<unknown>,
            name,
            rule,
        );
    }
    return result as T;
}

/**
 * Wrap a single function with Vault enforcement.
 *
 * Use this as an escape hatch for functions that can't be reached by
 * {@link autoInstrument} (e.g. defined inline or in a third-party module).
 * If a manifest has been loaded its rules are applied first; explicit options
 * always take precedence.
 *
 * ```ts
 * import { tool, currentToken } from "ledgix-ts";
 *
 * // Picks up policy from manifest if loaded, or enforces with no policy:
 * export const specialFn = tool(async (amount: number) => {
 *     const token = currentToken();
 *     // ...
 * });
 *
 * // Explicit override:
 * export const stripeCharge = tool(
 *     async (amount: number) => { ... },
 *     { policyId: "financial-high-risk" },
 * );
 * ```
 *
 * @param fn - Async function to wrap.
 * @param options - Optional name / policy / context overrides.
 */
export function tool<TArgs extends unknown[], TReturn>(
    fn: (...args: TArgs) => Promise<TReturn>,
    options?: {
        toolName?: string;
        policyId?: string;
        context?: Record<string, unknown>;
        // Phase 2 — GDPR Article 30 processing-register matching.
        dataCategories?: string[];
        purpose?: string;
        processingRegisterRef?: string;
        // Phase 6 — dataset lineage.
        datasetRef?: string;
    },
): (...args: TArgs) => Promise<TReturn> {
    const name = options?.toolName ?? fn.name ?? "unknown_tool";
    let policyId = options?.policyId;
    let context: Record<string, unknown> = { ...(options?.context ?? {}) };

    if (_manifest != null) {
        const rule = _manifest.match(name);
        if (rule != null) {
            policyId ??= rule.policyId;
            context = { ...(rule.context ?? {}), ...context };
        }
    }

    return enforce({
        toolName: name,
        policyId,
        context,
        dataCategories: options?.dataCategories,
        purpose: options?.purpose,
        processingRegisterRef: options?.processingRegisterRef,
        datasetRef: options?.datasetRef,
    })(fn);
}

/** @internal */
function _wrapWithRule(
    fn: (...args: unknown[]) => Promise<unknown>,
    name: string,
    rule: ManifestRule,
): (...args: unknown[]) => Promise<unknown> {
    return enforce({
        toolName: name,
        policyId: rule.policyId,
        context: rule.context ?? {},
    })(fn as (...args: unknown[]) => Promise<unknown>);
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
    // Phase 2 — GDPR Article 30 processing-register matching. When supplied,
    // the Vault's pre-LLM validator chain checks for an active register that
    // covers the requested (data_categories, purpose, recipient) tuple.
    /** Personal-data categories this action will touch. */
    dataCategories?: string[];
    /** Purpose of processing (e.g. 'fraud_detection', 'billing'). */
    purpose?: string;
    /** Optional UUID hint of the matching register. */
    processingRegisterRef?: string;
    // Phase 6 — dataset lineage.
    /** Logical dataset ref this action reads/writes. */
    datasetRef?: string;
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
                dataCategories: options?.dataCategories,
                purpose: options?.purpose,
                processingRegisterRef: options?.processingRegisterRef,
                datasetRef: options?.datasetRef,
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
    // Phase 2 / 6 — see EnforceOptions for full docs.
    dataCategories?: string[];
    purpose?: string;
    processingRegisterRef?: string;
    datasetRef?: string;
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
                dataCategories: options?.dataCategories,
                purpose: options?.purpose,
                processingRegisterRef: options?.processingRegisterRef,
                datasetRef: options?.datasetRef,
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
    // Phase 2 / 6 — see EnforceOptions for full docs.
    dataCategories?: string[];
    purpose?: string;
    processingRegisterRef?: string;
    datasetRef?: string;
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
        dataCategories: options.dataCategories,
        purpose: options.purpose,
        processingRegisterRef: options.processingRegisterRef,
        datasetRef: options.datasetRef,
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
