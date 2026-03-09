// Ledgix ALCV — Client
// Async HTTP client for Vault communication and A-JWT verification

import * as jose from "jose";

import type { VaultConfig } from "./config.js";
import { createVaultConfig } from "./config.js";
import {
    ClearanceDeniedError,
    ManualReviewTimeoutError,
    PolicyRegistrationError,
    TokenVerificationError,
    VaultConnectionError,
} from "./exceptions.js";
import type {
    ClearanceRequest,
    ClearanceResponse,
    PolicyRegistration,
    PolicyRegistrationResponse,
} from "./models.js";
import {
    ClearanceResponseSchema,
    PolicyRegistrationResponseSchema,
    toCamelCaseKeys,
    toSnakeCaseKeys,
} from "./models.js";

/**
 * Async client for the ALCV Vault.
 *
 * Usage:
 * ```ts
 * const client = new LedgixClient();
 * const resp = await client.requestClearance({
 *   toolName: "stripe_refund",
 *   toolArgs: { amount: 45 },
 *   agentId: "my-agent",
 *   sessionId: "",
 *   context: {},
 * });
 * ```
 */
export class LedgixClient {
    public readonly config: VaultConfig;
    private _jwksCache: Record<string, unknown> | null = null;

    constructor(config?: Partial<VaultConfig>) {
        this.config = createVaultConfig(config);
    }

    // ------------------------------------------------------------------
    // Internal HTTP helpers
    // ------------------------------------------------------------------

    private _headers(): Record<string, string> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        };
        if (this.config.vaultApiKey) {
            headers["X-Vault-API-Key"] = this.config.vaultApiKey;
        }
        return headers;
    }

    private async _fetch(path: string, init?: RequestInit): Promise<Response> {
        const url = `${this.config.vaultUrl}${path}`;
        try {
            const response = await fetch(url, {
                ...init,
                headers: { ...this._headers(), ...init?.headers },
                signal: AbortSignal.timeout(this.config.vaultTimeout),
            });
            return response;
        } catch (error: unknown) {
            if (error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError")) {
                throw new VaultConnectionError(
                    error instanceof DOMException
                        ? `Request timed out after ${this.config.vaultTimeout}ms`
                        : String(error),
                );
            }
            throw new VaultConnectionError(String(error));
        }
    }

    // ------------------------------------------------------------------
    // Clearance
    // ------------------------------------------------------------------

    /**
     * Send a clearance request to the Vault.
     *
     * @throws {ClearanceDeniedError} If the Vault denies the request.
     * @throws {VaultConnectionError} If the Vault is unreachable.
     */
    async requestClearance(request: ClearanceRequest): Promise<ClearanceResponse> {
        const body = toSnakeCaseKeys(request as unknown as Record<string, unknown>);
        const response = await this._fetch("/request-clearance", {
            method: "POST",
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            throw new VaultConnectionError(
                `Vault returned HTTP ${response.status}: ${await response.text()}`,
            );
        }

        const data = await response.json();
        const camelData = toCamelCaseKeys(data as Record<string, unknown>);
        const clearance = await this._resolvePendingClearance(ClearanceResponseSchema.parse(camelData));

        if (!clearance.approved) {
            throw new ClearanceDeniedError(clearance.reason, clearance.requestId || null);
        }

        if (this.config.verifyJwt && clearance.token) {
            await this.verifyToken(clearance.token);
        }

        return clearance;
    }

    // ------------------------------------------------------------------
    // Policy registration
    // ------------------------------------------------------------------

    private async _resolvePendingClearance(clearance: ClearanceResponse): Promise<ClearanceResponse> {
        if (clearance.status !== "pendingReview" && clearance.status !== "processing") {
            return clearance;
        }

        const deadline = Date.now() + this.config.reviewTimeout;
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, this.config.reviewPollInterval));
            const response = await this._fetch(`/clearance-status/${encodeURIComponent(clearance.requestId)}`);
            if (!response.ok) {
                throw new VaultConnectionError(
                    `Vault returned HTTP ${response.status}: ${await response.text()}`,
                );
            }
            const data = await response.json();
            const camelData = toCamelCaseKeys(data as Record<string, unknown>);
            clearance = ClearanceResponseSchema.parse(camelData);
            if (clearance.status !== "pendingReview" && clearance.status !== "processing") {
                return clearance;
            }
        }

        throw new ManualReviewTimeoutError(clearance.requestId || null);
    }

    /**
     * Register a policy with the Vault.
     *
     * @throws {PolicyRegistrationError} If the registration fails.
     * @throws {VaultConnectionError} If the Vault is unreachable.
     */
    async registerPolicy(policy: PolicyRegistration): Promise<PolicyRegistrationResponse> {
        const body = toSnakeCaseKeys(policy as unknown as Record<string, unknown>);
        const response = await this._fetch("/register-policy", {
            method: "POST",
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            throw new PolicyRegistrationError(
                `Vault returned HTTP ${response.status}: ${await response.text()}`,
            );
        }

        const data = await response.json();
        const camelData = toCamelCaseKeys(data as Record<string, unknown>);
        return PolicyRegistrationResponseSchema.parse(camelData);
    }

    // ------------------------------------------------------------------
    // JWKS + A-JWT verification
    // ------------------------------------------------------------------

    /**
     * Fetch the Vault's JWKS (JSON Web Key Set) for token verification.
     */
    async fetchJwks(): Promise<Record<string, unknown>> {
        const response = await this._fetch("/.well-known/jwks.json");

        if (!response.ok) {
            throw new VaultConnectionError(
                `Failed to fetch JWKS: HTTP ${response.status}`,
            );
        }

        this._jwksCache = (await response.json()) as Record<string, unknown>;
        return this._jwksCache;
    }

    /**
     * Verify an A-JWT using the Vault's public key.
     *
     * Returns the decoded token payload on success.
     *
     * @throws {TokenVerificationError} If the token is invalid, expired, or the JWKS cannot be fetched.
     */
    async verifyToken(token: string): Promise<Record<string, unknown>> {
        if (!this._jwksCache) {
            await this.fetchJwks();
        }

        if (!this._jwksCache) {
            throw new TokenVerificationError("No JWKS available from Vault");
        }

        try {
            const jwks = this._jwksCache as { keys?: Record<string, unknown>[] };
            if (!jwks.keys || jwks.keys.length === 0) {
                throw new TokenVerificationError("JWKS contains no keys");
            }

            // Import the first Ed25519 public key from the JWKS
            const keyData = jwks.keys[0];
            const publicKey = await jose.importJWK(keyData as jose.JWK, "EdDSA");

            const { payload } = await jose.jwtVerify(token, publicKey, {
                algorithms: ["EdDSA"],
                issuer: this.config.jwtIssuer,
                audience: this.config.jwtAudience,
                subject: "clearance",
            });

            return payload as Record<string, unknown>;
        } catch (error: unknown) {
            if (error instanceof TokenVerificationError) {
                throw error;
            }
            if (error instanceof jose.errors.JWTExpired) {
                throw new TokenVerificationError("A-JWT has expired");
            }
            if (
                error instanceof jose.errors.JWTClaimValidationFailed ||
                error instanceof jose.errors.JWSSignatureVerificationFailed ||
                error instanceof jose.errors.JWTInvalid
            ) {
                throw new TokenVerificationError(`Invalid A-JWT: ${error.message}`);
            }
            throw new TokenVerificationError(
                `Token verification failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /**
     * Clean up resources. Currently a no-op since native fetch has no persistent client,
     * but provided for API parity with the Python SDK and future extensibility.
     */
    async close(): Promise<void> {
        // Native fetch has no persistent connection pool to close.
        // This method exists for API parity with the Python SDK.
    }
}
