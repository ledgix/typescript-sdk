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
        reviewTimeout: overrides?.reviewTimeout ?? parseTimeout(env.LEDGIX_REVIEW_TIMEOUT) ?? 300000,
        maxRetries: overrides?.maxRetries ?? parseTimeout(env.LEDGIX_MAX_RETRIES) ?? 3,
        retryBaseDelay: overrides?.retryBaseDelay ?? parseTimeout(env.LEDGIX_RETRY_BASE_DELAY) ?? 500,
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
