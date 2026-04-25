// Ledgix ALCV — Configuration
// Environment-driven configuration for the Vault client

/**
 * Configuration for connecting to the ALCV Vault.
 *
 * Values are loaded from environment variables prefixed with `LEDGIX_`,
 * e.g. `LEDGIX_VAULT_URL`, or can be passed directly via the constructor override.
 */
export interface VaultConfig {
    /** Base URL of the ALCV Vault server. Env: LEDGIX_VAULT_URL */
    vaultUrl: string;
    /** API key sent as `X-Vault-API-Key` header for Shim→Vault auth. Env: LEDGIX_VAULT_API_KEY */
    vaultApiKey: string;
    /** HTTP request timeout in milliseconds. Env: LEDGIX_VAULT_TIMEOUT */
    vaultTimeout: number;
    /** Whether to verify A-JWTs returned by the Vault using its JWKS endpoint. Env: LEDGIX_VERIFY_JWT */
    verifyJwt: boolean;
    /** Expected issuer for Vault A-JWTs. Env: LEDGIX_JWT_ISSUER */
    jwtIssuer: string;
    /** Expected audience for Vault A-JWTs. Env: LEDGIX_JWT_AUDIENCE */
    jwtAudience: string;
    /** Identifier for the agent using this SDK instance. Env: LEDGIX_AGENT_ID */
    agentId: string;
    /** Optional session identifier for grouping related clearance requests. Env: LEDGIX_SESSION_ID */
    sessionId: string;
    /** Poll interval in milliseconds while waiting for manual review. Env: LEDGIX_REVIEW_POLL_INTERVAL */
    reviewPollInterval: number;
    /** Maximum time to wait for a manual review in milliseconds. Env: LEDGIX_REVIEW_TIMEOUT */
    reviewTimeout: number;
    /** Maximum number of retry attempts for transient failures (connection errors, 5xx). Env: LEDGIX_MAX_RETRIES */
    maxRetries: number;
    /** Base delay in milliseconds for exponential backoff between retries (full jitter applied). Env: LEDGIX_RETRY_BASE_DELAY */
    retryBaseDelay: number;
    /** Enable the in-process decision cache. Off by default — opt-in for safety. Env: LEDGIX_DECISION_CACHE_ENABLED */
    decisionCacheEnabled: boolean;
    /** TTL in milliseconds for cached decision envelopes. Env: LEDGIX_DECISION_CACHE_TTL_MS */
    decisionCacheTtlMs: number;
    /** Maximum number of decision envelopes to keep in memory. Env: LEDGIX_DECISION_CACHE_MAX_ENTRIES */
    decisionCacheMaxEntries: number;
    /** Advisory OIDC sub of the human on whose behalf the agent acts. Sent as human_principal on every request. Env: LEDGIX_PRINCIPAL_ID */
    principalId: string | undefined;
    /**
     * How to handle pending manual reviews.
     * - `"block"` (default): poll until a decision arrives or timeout expires.
     * - `"detach"`: throw {@link ReviewPendingError} immediately with a {@link PendingApproval} handle.
     * Env: LEDGIX_REVIEW_MODE
     */
    reviewMode: "block" | "detach";
    /** How long (ms) the cached JWKS is considered fresh before a key-miss triggers a refetch. Default 300_000 (5 min). Env: LEDGIX_JWKS_TTL_MS */
    jwksTtlMs: number;
    /** Maximum number of consumed A-JWT jtis held in the in-process replay cache. Env: LEDGIX_REPLAY_CACHE_SIZE */
    replayCacheSize: number;
    /** TTL (ms) for entries in the replay cache. Should be at least JWT TTL + 30 s clock-skew buffer. Default 330_000. Env: LEDGIX_MAX_TOKEN_LIFETIME_MS */
    maxTokenLifetimeMs: number;
}

/**
 * Create a VaultConfig with defaults from environment variables.
 *
 * Any field in `overrides` takes precedence over env vars, which take precedence over defaults.
 */
export function createVaultConfig(overrides?: Partial<VaultConfig>): VaultConfig {
    const env = typeof process !== "undefined" ? process.env : {};

    return {
        vaultUrl: overrides?.vaultUrl ?? env.LEDGIX_VAULT_URL ?? "http://localhost:8000",
        vaultApiKey: overrides?.vaultApiKey ?? env.LEDGIX_VAULT_API_KEY ?? "",
        vaultTimeout: overrides?.vaultTimeout ?? parseTimeout(env.LEDGIX_VAULT_TIMEOUT) ?? 30000,
        verifyJwt: overrides?.verifyJwt ?? parseBool(env.LEDGIX_VERIFY_JWT) ?? true,
        jwtIssuer: overrides?.jwtIssuer ?? env.LEDGIX_JWT_ISSUER ?? "alcv-vault",
        jwtAudience: overrides?.jwtAudience ?? env.LEDGIX_JWT_AUDIENCE ?? "ledgix-sdk",
        agentId: overrides?.agentId ?? env.LEDGIX_AGENT_ID ?? "default-agent",
        sessionId: overrides?.sessionId ?? env.LEDGIX_SESSION_ID ?? "",
        reviewPollInterval: overrides?.reviewPollInterval ?? parseTimeout(env.LEDGIX_REVIEW_POLL_INTERVAL) ?? 2000,
        reviewTimeout: overrides?.reviewTimeout ?? parseTimeout(env.LEDGIX_REVIEW_TIMEOUT) ?? 900_000,
        maxRetries: overrides?.maxRetries ?? parseTimeout(env.LEDGIX_MAX_RETRIES) ?? 3,
        retryBaseDelay: overrides?.retryBaseDelay ?? parseTimeout(env.LEDGIX_RETRY_BASE_DELAY) ?? 500,
        decisionCacheEnabled: overrides?.decisionCacheEnabled ?? parseBool(env.LEDGIX_DECISION_CACHE_ENABLED) ?? false,
        decisionCacheTtlMs: overrides?.decisionCacheTtlMs ?? parseTimeout(env.LEDGIX_DECISION_CACHE_TTL_MS) ?? 60_000,
        decisionCacheMaxEntries: overrides?.decisionCacheMaxEntries ?? parseTimeout(env.LEDGIX_DECISION_CACHE_MAX_ENTRIES) ?? 1000,
        principalId: overrides?.principalId ?? env.LEDGIX_PRINCIPAL_ID ?? undefined,
        reviewMode: overrides?.reviewMode ?? (env.LEDGIX_REVIEW_MODE === "detach" ? "detach" : "block"),
        jwksTtlMs: overrides?.jwksTtlMs ?? parseTimeout(env.LEDGIX_JWKS_TTL_MS) ?? 300_000,
        replayCacheSize: overrides?.replayCacheSize ?? parseTimeout(env.LEDGIX_REPLAY_CACHE_SIZE) ?? 10_000,
        maxTokenLifetimeMs: overrides?.maxTokenLifetimeMs ?? parseTimeout(env.LEDGIX_MAX_TOKEN_LIFETIME_MS) ?? 330_000,
    };
}

function parseTimeout(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}

function parseBool(value: string | undefined): boolean | undefined {
    if (value === undefined) return undefined;
    const lower = value.toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes") return true;
    if (lower === "false" || lower === "0" || lower === "no") return false;
    return undefined;
}
