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
    LedgerEntry,
    LedgerManifest,
    LedgerVerificationResult,
    PolicyRegistration,
    PolicyRegistrationResponse,
} from "./models.js";
import {
    ClearanceResponseSchema,
    LedgerEntrySchema,
    LedgerManifestSchema,
    LedgerVerificationResultSchema,
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

    private static readonly _retryableStatuses = new Set([429, 500, 502, 503, 504]);

    private _backoffDelay(attempt: number): number {
        /** Exponential backoff with full jitter, capped at 30 seconds. */
        const delay = Math.min(30_000, this.config.retryBaseDelay * 2 ** attempt);
        return Math.random() * delay;
    }

    private async _fetch(path: string, init?: RequestInit): Promise<Response> {
        const url = `${this.config.vaultUrl}${path}`;
        let lastError: VaultConnectionError | null = null;

        for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            let response: Response;
            try {
                response = await fetch(url, {
                    ...init,
                    headers: { ...this._headers(), ...init?.headers },
                    signal: AbortSignal.timeout(this.config.vaultTimeout),
                });
            } catch (error: unknown) {
                const isTimeout = error instanceof DOMException && error.name === "AbortError";
                const message = isTimeout
                    ? `Request timed out after ${this.config.vaultTimeout}ms`
                    : String(error);
                lastError = new VaultConnectionError(message);
                if (attempt < this.config.maxRetries) {
                    await new Promise<void>((resolve) =>
                        setTimeout(resolve, this._backoffDelay(attempt)),
                    );
                    continue;
                }
                throw lastError;
            }

            if (LedgixClient._retryableStatuses.has(response.status) && attempt < this.config.maxRetries) {
                await new Promise<void>((resolve) =>
                    setTimeout(resolve, this._backoffDelay(attempt)),
                );
                continue;
            }

            return response;
        }

        throw lastError ?? new VaultConnectionError("Max retries exceeded");
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

    async fetchLedger(limit = 100): Promise<LedgerEntry[]> {
        const response = await this._fetch(`/ledger?limit=${encodeURIComponent(String(limit))}`);

        if (!response.ok) {
            throw new VaultConnectionError(`Failed to fetch ledger: HTTP ${response.status}`);
        }

        const data = toCamelCaseKeys((await response.json()) as Record<string, unknown>);
        const entries = Array.isArray(data.entries) ? data.entries : [];
        return entries.map((entry) => LedgerEntrySchema.parse(entry));
    }

    async fetchLedgerManifests(limit = 24): Promise<LedgerManifest[]> {
        const response = await this._fetch(`/ledger/manifests?limit=${encodeURIComponent(String(limit))}`);

        if (!response.ok) {
            throw new VaultConnectionError(`Failed to fetch ledger manifests: HTTP ${response.status}`);
        }

        const data = toCamelCaseKeys((await response.json()) as Record<string, unknown>);
        const manifests = Array.isArray(data.manifests) ? data.manifests : [];
        return manifests.map((manifest) => LedgerManifestSchema.parse(manifest));
    }

    async verifyLedgerProof(entries: LedgerEntry[], manifests: LedgerManifest[] = []): Promise<LedgerVerificationResult> {
        if (!this._jwksCache) {
            await this.fetchJwks();
        }

        if (!this._jwksCache) {
            throw new TokenVerificationError("No JWKS available from Vault");
        }

        const jwks = this._jwksCache as { keys?: Record<string, unknown>[] };
        if (!jwks.keys || jwks.keys.length === 0) {
            throw new TokenVerificationError("JWKS contains no keys");
        }

        const keyCache = new Map<string, CryptoKey>();
        const keyForKid = async (kid: string): Promise<CryptoKey> => {
            if (keyCache.has(kid)) {
                return keyCache.get(kid)!;
            }

            const jwk = jwks.keys!.find((item) => item.kid === kid);
            if (!jwk) {
                throw new TokenVerificationError(`No JWKS key found for kid ${kid}`);
            }

            const imported = await jose.importJWK(jwk as jose.JWK, "EdDSA");
            keyCache.set(kid, imported as CryptoKey);
            return imported as CryptoKey;
        };

        const sortedEntries = [...entries].sort((a, b) => a.seq - b.seq);
        let previousRowHash = "0000000000000000000000000000000000000000000000000000000000000000";

        for (const entry of sortedEntries) {
            if (entry.prevRowHash !== previousRowHash) {
                throw new TokenVerificationError(`Ledger chain broken at seq ${entry.seq}`);
            }
            if (entry.signatureAlgorithm !== "Ed25519") {
                throw new TokenVerificationError(`Unsupported ledger signature algorithm ${entry.signatureAlgorithm}`);
            }

            const payloadBytes = decodeBase64Url(entry.receiptPayload);
            const signatureBytes = decodeBase64Url(entry.rowSignature);
            const key = await keyForKid(entry.signerKeyId);
            const verified = await crypto.subtle.verify("Ed25519", key, signatureBytes, payloadBytes);
            if (!verified) {
                throw new TokenVerificationError(`Ledger receipt signature invalid at seq ${entry.seq}`);
            }

            const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<string, unknown>;
            if (payload.row_hash !== entry.rowHash || payload.prev_row_hash !== entry.prevRowHash || payload.seq !== entry.seq) {
                throw new TokenVerificationError(`Ledger receipt payload mismatch at seq ${entry.seq}`);
            }

            previousRowHash = entry.rowHash;
        }

        const sortedManifests = [...manifests].sort(
            (a, b) => new Date(a.periodStart).getTime() - new Date(b.periodStart).getTime(),
        );
        let previousManifestHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

        for (const manifest of sortedManifests) {
            if (manifest.prevManifestHash !== previousManifestHash) {
                throw new TokenVerificationError(`Ledger manifest chain broken at period ${manifest.periodStart}`);
            }
            if (manifest.signatureAlgorithm !== "Ed25519") {
                throw new TokenVerificationError(`Unsupported manifest signature algorithm ${manifest.signatureAlgorithm}`);
            }

            const payloadBytes = decodeBase64Url(manifest.manifestPayload);
            const manifestHash = await sha256Hex(payloadBytes);
            if (`sha256:${manifestHash}` !== manifest.manifestHash) {
                throw new TokenVerificationError(`Ledger manifest hash mismatch for period ${manifest.periodStart}`);
            }

            const signatureBytes = decodeBase64Url(manifest.manifestSignature);
            const key = await keyForKid(manifest.signerKeyId);
            const verified = await crypto.subtle.verify("Ed25519", key, signatureBytes, payloadBytes);
            if (!verified) {
                throw new TokenVerificationError(`Ledger manifest signature invalid for period ${manifest.periodStart}`);
            }

            previousManifestHash = manifest.manifestHash;
        }

        if (sortedEntries.length > 0 && sortedManifests.length > 0) {
            const latestEntry = sortedEntries[sortedEntries.length - 1];
            const latestManifest = sortedManifests[sortedManifests.length - 1];
            if (latestManifest.headSeq < latestEntry.seq) {
                throw new TokenVerificationError("Latest manifest trails the latest ledger entry");
            }
        }

        return LedgerVerificationResultSchema.parse({
            intact: true,
            verifiedEntries: sortedEntries.length,
            verifiedManifests: sortedManifests.length,
            latestRowHash: sortedEntries.length ? sortedEntries[sortedEntries.length - 1].rowHash : null,
            latestManifestHash: sortedManifests.length ? sortedManifests[sortedManifests.length - 1].manifestHash : null,
        });
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

function decodeBase64Url(value: string): Uint8Array {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", value);
    return Array.from(new Uint8Array(digest))
        .map((item) => item.toString(16).padStart(2, "0"))
        .join("");
}
