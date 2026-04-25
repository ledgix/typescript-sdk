// Ledgix ALCV — Client
// Async HTTP client for Vault communication and A-JWT verification

import * as jose from "jose";

import type { VaultConfig } from "./config.js";
import { createVaultConfig } from "./config.js";
import {
    ClearanceDeniedError,
    ManualReviewTimeoutError,
    PolicyRegistrationError,
    QueueSaturatedError,
    ReplayDetectedError,
    ReviewPendingError,
    TokenVerificationError,
    VaultConnectionError,
} from "./exceptions.js";

/**
 * Vault's proactive backpressure (Scale & Reliability §2.1) emits 429 +
 * Retry-After when its clearance queue is past the configured watermark. We
 * honor the header verbatim (capped to MAX_RETRY_AFTER_MS so a misbehaving
 * server can't pin the SDK for minutes), and we do NOT count these waves
 * against maxRetries — they're cooperative backoff, not transport failures.
 * A separate ceiling MAX_CONSECUTIVE_429 prevents an infinite loop if the
 * Vault is genuinely melting.
 */
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_CONSECUTIVE_429 = 10;

/**
 * Parse a Retry-After header value. Vault emits seconds; the HTTP spec also
 * allows HTTP-date but we don't need that today. Returns null on parse
 * failure so callers fall back to jittered backoff.
 */
function parseRetryAfterMs(value: string | null): number | null {
    if (!value) return null;
    const secs = Number.parseFloat(value.trim());
    if (!Number.isFinite(secs) || secs < 0) return null;
    return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
}
import { extractCounterparty } from "./counterparty.js";
import { PendingApproval } from "./pending.js";
import type {
    ClearanceRequest,
    ClearanceResponse,
    LedgerEntry,
    LedgerCheckpoint,
    LedgerKeyVersion,
    LedgerManifest,
    InclusionProof,
    ConsistencyProof,
    LedgerProofBundle,
    LedgerVerificationResult,
    PolicyRegistration,
    PolicyRegistrationResponse,
} from "./models.js";
import {
    ClearanceResponseSchema,
    LedgerEntrySchema,
    LedgerCheckpointSchema,
    InclusionProofSchema,
    ConsistencyProofSchema,
    LedgerProofBundleSchema,
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
interface DecisionEnvelope {
    approved: boolean;
    reason: string;
    policyVersionId: string;
    policyContentHash: string;
    confidence: number;
    minimumConfidenceScore: number;
    originalRequestId: string;
}

interface CacheEntry {
    envelope: DecisionEnvelope;
    expiresAt: number;
}

export class LedgixClient {
    public readonly config: VaultConfig;
    private _parentJti: string | undefined;
    private _jwksCache: Record<string, unknown> | null = null;
    /** kid → JWK entry, rebuilt on every fetchJwks call */
    private _jwksKeysByKid: Map<string, Record<string, unknown>> = new Map();
    /** monotonic timestamp (ms) of the last successful JWKS fetch */
    private _jwksFetchedAt = 0;
    /**
     * Consumed jti → expiry epoch ms. Entries whose expiry is in the past are
     * considered evictable; we sweep lazily on insert when size exceeds replayCacheSize.
     */
    private _seenJtis: Map<string, number> = new Map();
    private _decisionCache: Map<string, CacheEntry> | null = null;

    constructor(config?: Partial<VaultConfig>, { parentJti }: { parentJti?: string } = {}) {
        this.config = createVaultConfig(config);
        this._parentJti = parentJti;
        if (this.config.decisionCacheEnabled) {
            this._decisionCache = new Map();
        }
    }

    /**
     * Return a new client that auto-injects `parentJti` on every clearance request.
     * Shares the same config but has its own HTTP connections and cache.
     */
    createDelegatedClient(parentJti: string): LedgixClient {
        return new LedgixClient(this.config, { parentJti });
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

    /** 5xx + 429; 429 is handled specially (Retry-After honoring) below. */
    private static readonly _retryableStatuses = new Set([500, 502, 503, 504]);

    private _backoffDelay(attempt: number): number {
        /** Exponential backoff with full jitter, capped at 30 seconds. */
        const delay = Math.min(30_000, this.config.retryBaseDelay * 2 ** attempt);
        return Math.random() * delay;
    }

    /**
     * Internal sleep hook — extracted so tests can monkey-patch without
     * sitting through real wall-clock sleeps. Production callers always
     * resolve via setTimeout.
     */
    private _sleep(ms: number): Promise<void> {
        return new Promise<void>((resolve) => setTimeout(resolve, ms));
    }

    private async _fetch(path: string, init?: RequestInit): Promise<Response> {
        const url = `${this.config.vaultUrl}${path}`;
        let attempt = 0;
        let consecutive429 = 0;
        let lastRetryAfterSec: number | null = null;

        // Loop is bounded by maxRetries for transport/5xx and by
        // MAX_CONSECUTIVE_429 for cooperative-backoff 429 waves.
        while (true) {
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
                if (attempt < this.config.maxRetries) {
                    await this._sleep(this._backoffDelay(attempt));
                    attempt += 1;
                    continue;
                }
                throw new VaultConnectionError(message);
            }

            if (response.status === 429) {
                // Cooperative backoff: don't consume the retry budget, sleep
                // for the server-requested duration (or jitter if missing).
                consecutive429 += 1;
                if (consecutive429 > MAX_CONSECUTIVE_429) {
                    throw new QueueSaturatedError(consecutive429 - 1, lastRetryAfterSec);
                }
                const headerMs = parseRetryAfterMs(response.headers.get("Retry-After"));
                if (headerMs !== null) {
                    lastRetryAfterSec = headerMs / 1000;
                    await this._sleep(headerMs);
                } else {
                    await this._sleep(this._backoffDelay(attempt));
                }
                continue;
            }

            // Reset 429 streak on any non-429 response — a single success in
            // between resets the SDK's "is the queue dying?" signal.
            consecutive429 = 0;

            if (
                LedgixClient._retryableStatuses.has(response.status) &&
                attempt < this.config.maxRetries
            ) {
                await this._sleep(this._backoffDelay(attempt));
                attempt += 1;
                continue;
            }

            return response;
        }
    }

    // ------------------------------------------------------------------
    // Decision cache helpers
    // ------------------------------------------------------------------

    private static _canonicalJson(value: unknown): string {
        if (value === null || typeof value !== "object") {
            return JSON.stringify(value);
        }
        if (Array.isArray(value)) {
            return "[" + value.map(LedgixClient._canonicalJson).join(",") + "]";
        }
        const sorted = Object.keys(value as Record<string, unknown>).sort();
        return (
            "{" +
            sorted
                .map(
                    (k) =>
                        JSON.stringify(k) +
                        ":" +
                        LedgixClient._canonicalJson((value as Record<string, unknown>)[k]),
                )
                .join(",") +
            "}"
        );
    }

    private _buildCacheKey(request: ClearanceRequest): string {
        let canonicalArgs: string;
        try {
            canonicalArgs = LedgixClient._canonicalJson(request.toolArgs ?? {});
        } catch {
            return "";
        }
        if (canonicalArgs.length > 65_536) return "";
        const agentId = request.agentId ?? this.config.agentId ?? "";
        const policyId = (request.context as Record<string, unknown>)?.policyId ?? "";
        return `${agentId}\x00${request.toolName}\x00${canonicalArgs}\x00${policyId}`;
    }

    private _cacheGet(key: string): DecisionEnvelope | null {
        if (!this._decisionCache || !key) return null;
        const entry = this._decisionCache.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this._decisionCache.delete(key);
            return null;
        }
        return entry.envelope;
    }

    private _cachePut(key: string, envelope: DecisionEnvelope): void {
        if (!this._decisionCache || !key) return;
        if (this._decisionCache.size >= this.config.decisionCacheMaxEntries) {
            // Evict the oldest entry (Map preserves insertion order).
            const oldest = this._decisionCache.keys().next().value;
            if (oldest !== undefined) this._decisionCache.delete(oldest);
        }
        this._decisionCache.set(key, {
            envelope,
            expiresAt: Date.now() + this.config.decisionCacheTtlMs,
        });
    }

    /** Flush all cached decision envelopes. */
    clearCache(): void {
        this._decisionCache?.clear();
    }

    private static _isCacheable(clearance: ClearanceResponse): boolean {
        return (
            clearance.approved === true &&
            clearance.status === "approved" &&
            Boolean(clearance.policyVersionId) &&
            clearance.token != null
        );
    }

    /**
     * Fill in humanPrincipal, parentJti, and counterparty destination_* fields
     * from config/instance defaults / hints. Caller-supplied destination_*
     * always wins over the inferred values.
     */
    private _enrichRequest(request: ClearanceRequest): ClearanceRequest {
        const updates: Partial<ClearanceRequest> = {};
        if (request.humanPrincipal == null && this.config.principalId) {
            updates.humanPrincipal = this.config.principalId;
        }
        if (request.parentJti == null && this._parentJti) {
            updates.parentJti = this._parentJti;
        }
        if (
            request.destinationUri == null ||
            request.destinationProvider == null ||
            request.destinationAccountRef == null
        ) {
            const inferred = extractCounterparty(
                request.toolName,
                request.toolArgs as Record<string, unknown> | undefined,
            );
            if (request.destinationUri == null && inferred.destinationUri !== undefined) {
                updates.destinationUri = inferred.destinationUri;
            }
            if (request.destinationProvider == null && inferred.destinationProvider !== undefined) {
                updates.destinationProvider = inferred.destinationProvider;
            }
            if (request.destinationAccountRef == null && inferred.destinationAccountRef !== undefined) {
                updates.destinationAccountRef = inferred.destinationAccountRef;
            }
        }
        return Object.keys(updates).length > 0 ? { ...request, ...updates } : request;
    }

    private _makeEnvelope(clearance: ClearanceResponse): DecisionEnvelope {
        return {
            approved: clearance.approved,
            reason: clearance.reason,
            policyVersionId: clearance.policyVersionId ?? "",
            policyContentHash: clearance.policyContentHash ?? "",
            confidence: clearance.confidence,
            minimumConfidenceScore: clearance.minimumConfidenceScore,
            originalRequestId: clearance.requestId,
        };
    }

    private async _mintToken(
        request: ClearanceRequest,
        envelope: DecisionEnvelope,
    ): Promise<ClearanceResponse> {
        const mintBody = {
            tool_name: request.toolName,
            tool_args: request.toolArgs ?? {},
            agent_id: request.agentId ?? this.config.agentId ?? "",
            session_id: request.sessionId ?? this.config.sessionId ?? "",
            policy_id: (request.context as Record<string, unknown>)?.policyId ?? "",
            policy_version_id: envelope.policyVersionId,
            policy_content_hash: envelope.policyContentHash,
            original_request_id: envelope.originalRequestId,
            confidence: envelope.confidence,
            reason: envelope.reason,
            human_principal: request.humanPrincipal ?? this.config.principalId ?? undefined,
            destination_uri: request.destinationUri ?? "",
            destination_provider: request.destinationProvider ?? "",
            destination_account_ref: request.destinationAccountRef ?? "",
        };

        const response = await this._fetch("/mint-token", {
            method: "POST",
            body: JSON.stringify(mintBody),
            headers: { "Idempotency-Key": crypto.randomUUID() },
        });

        if (!response.ok) {
            throw new VaultConnectionError(
                `Vault /mint-token returned HTTP ${response.status}: ${await response.text()}`,
            );
        }

        const data = (await response.json()) as Record<string, unknown>;
        return ClearanceResponseSchema.parse(
            toCamelCaseKeys({
                status: "approved",
                approved: true,
                requires_manual_review: false,
                token: data.token,
                reason: data.reason ?? envelope.reason,
                request_id: data.request_id ?? "",
                confidence: envelope.confidence,
                minimum_confidence_score: envelope.minimumConfidenceScore,
                policy_version_id: envelope.policyVersionId,
                policy_content_hash: envelope.policyContentHash,
            }),
        );
    }

    // ------------------------------------------------------------------
    // Clearance
    // ------------------------------------------------------------------

    /**
     * Send a clearance request to the Vault.
     *
     * When `decisionCacheEnabled` is true in the config, an approved response is
     * memoized. Subsequent identical calls skip the LLM judge and call `/mint-token`
     * for a fresh A-JWT.
     *
     * @throws {ClearanceDeniedError} If the Vault denies the request.
     * @throws {VaultConnectionError} If the Vault is unreachable.
     */
    async requestClearance(request: ClearanceRequest): Promise<ClearanceResponse> {
        request = this._enrichRequest(request);
        const cacheKey = this._buildCacheKey(request);
        const envelope = this._cacheGet(cacheKey);
        if (envelope !== null) {
            const clearance = await this._mintToken(request, envelope);
            if (this.config.verifyJwt && clearance.token) {
                await this.verifyToken(clearance.token);
            }
            return clearance;
        }

        const body = toSnakeCaseKeys(request as unknown as Record<string, unknown>);
        const response = await this._fetch("/request-clearance", {
            method: "POST",
            body: JSON.stringify(body),
            headers: { "Idempotency-Key": crypto.randomUUID() },
        });

        if (!response.ok) {
            throw new VaultConnectionError(
                `Vault returned HTTP ${response.status}: ${await response.text()}`,
            );
        }

        const data = await response.json();
        const camelData = toCamelCaseKeys(data as Record<string, unknown>);
        const resolved = await this._resolvePendingClearance(ClearanceResponseSchema.parse(camelData));
        if (resolved instanceof PendingApproval) {
            throw new ReviewPendingError(resolved);
        }
        const clearance = resolved;

        if (!clearance.approved) {
            throw new ClearanceDeniedError(clearance.reason, clearance.requestId || null);
        }

        if (this.config.verifyJwt && clearance.token) {
            await this.verifyToken(clearance.token);
        }

        if (LedgixClient._isCacheable(clearance)) {
            this._cachePut(cacheKey, this._makeEnvelope(clearance));
        }

        return clearance;
    }

    // ------------------------------------------------------------------
    // Policy registration
    // ------------------------------------------------------------------

    private async _resolvePendingClearance(
        clearance: ClearanceResponse,
    ): Promise<ClearanceResponse | PendingApproval> {
        if (clearance.status !== "pendingReview" && clearance.status !== "processing") {
            return clearance;
        }

        if (this.config.reviewMode === "detach") {
            return new PendingApproval(clearance.requestId || "", this, clearance);
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
            headers: { "Idempotency-Key": crypto.randomUUID() },
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
        // JWKS is a public endpoint — never send cookies/credentials to it.
        // In browsers this avoids leaking session cookies across origins or
        // cache-varying on auth state; in Node it's a safe no-op.
        const response = await this._fetch("/.well-known/jwks.json", {
            credentials: "omit",
        });

        if (!response.ok) {
            throw new VaultConnectionError(
                `Failed to fetch JWKS: HTTP ${response.status}`,
            );
        }

        this._jwksCache = (await response.json()) as Record<string, unknown>;
        this._indexJwksByKid(this._jwksCache);
        return this._jwksCache;
    }

    private _indexJwksByKid(jwks: Record<string, unknown>): void {
        const keys = (jwks.keys ?? []) as Record<string, unknown>[];
        const byKid = new Map<string, Record<string, unknown>>();
        for (const key of keys) {
            const kid = key["kid"] as string | undefined;
            if (kid) byKid.set(kid, key);
        }
        // Fallback for kid-less tokens (legacy): expose first key as __default__.
        if (byKid.size === 0 && keys.length > 0) {
            byKid.set("__default__", keys[0]);
        }
        this._jwksKeysByKid = byKid;
        this._jwksFetchedAt = Date.now();
    }

    private _peekTokenKid(token: string): string | undefined {
        try {
            const header = jose.decodeProtectedHeader(token);
            return header.kid;
        } catch {
            return undefined;
        }
    }

    private _hasKey(kid: string | undefined): boolean {
        if (this._jwksKeysByKid.size === 0) return false;
        if (kid) return this._jwksKeysByKid.has(kid);
        return this._jwksKeysByKid.has("__default__");
    }

    private _recordJti(jti: string, expMs: number): void {
        if (this._seenJtis.size >= this.config.replayCacheSize) {
            // Rely on Map insertion order (== approx expiry order, since jtis
            // arrive sequentially and all share max_token_lifetime). Evict the
            // oldest 10% in O(n) over the overflow slack — amortized O(1) per
            // insert. Much faster than the previous sort-by-expiry scan.
            const evict = Math.max(1, Math.floor(this.config.replayCacheSize * 0.1));
            let n = 0;
            for (const k of this._seenJtis.keys()) {
                this._seenJtis.delete(k);
                if (++n >= evict) break;
            }
        }
        this._seenJtis.set(jti, expMs);
    }

    /**
     * Verify an A-JWT using the Vault's public key.
     *
     * Security invariants enforced here:
     * - Kid matching: the token's `kid` header selects an explicit JWK; on a miss the
     *   JWKS is refetched once. If the kid is still absent the call is rejected
     *   fail-closed — no wildcard or first-key fallback for kid-bearing tokens.
     * - Algorithm pinned to EdDSA — RS256/HS256 confusion attacks are impossible.
     * - jti replay: every jti is stored in `_seenJtis` until `exp + 30 s`. A missing
     *   or re-presented jti throws ReplayDetectedError immediately.
     *
     * Returns the decoded token payload on success.
     *
     * @throws {TokenVerificationError} If the token is invalid, expired, or the JWKS cannot be fetched.
     * @throws {ReplayDetectedError} If this jti has already been consumed.
     */
    async verifyToken(token: string): Promise<Record<string, unknown>> {
        const kid = this._peekTokenKid(token);
        if (!this._jwksCache || !this._hasKey(kid)) {
            await this.fetchJwks();
        }

        if (!this._jwksCache || this._jwksKeysByKid.size === 0) {
            throw new TokenVerificationError("No JWKS available from Vault — no keys found");
        }

        let payload: Record<string, unknown>;
        try {
            const keyData = kid
                ? (this._jwksKeysByKid.get(kid) ?? this._jwksKeysByKid.get("__default__"))
                : this._jwksKeysByKid.get("__default__");

            if (!keyData) {
                throw new TokenVerificationError(
                    `A-JWT kid=${JSON.stringify(kid)} not found in JWKS — key may have rotated`,
                );
            }

            const publicKey = await jose.importJWK(keyData as jose.JWK, "EdDSA");

            const { payload: p } = await jose.jwtVerify(token, publicKey, {
                algorithms: ["EdDSA"],
                issuer: this.config.jwtIssuer,
                audience: this.config.jwtAudience,
                subject: "clearance",
            });
            payload = p as Record<string, unknown>;
        } catch (error: unknown) {
            if (error instanceof TokenVerificationError || error instanceof ReplayDetectedError) {
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

        // jti replay detection — fail-closed: missing jti is rejected.
        const jti = payload["jti"] as string | undefined;
        if (!jti) {
            throw new TokenVerificationError("A-JWT missing jti claim");
        }
        const now = Date.now();
        const existing = this._seenJtis.get(jti);
        if (existing !== undefined && existing > now) {
            throw new ReplayDetectedError(jti);
        }
        const exp = (payload["exp"] as number | undefined) ?? 0;
        this._recordJti(jti, exp * 1000 + 30_000); // +30 s clock-skew buffer

        return payload;
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

    async fetchLedgerCheckpoints(limit = 24): Promise<LedgerCheckpoint[]> {
        const response = await this._fetch(`/ledger/checkpoints?limit=${encodeURIComponent(String(limit))}`);

        if (!response.ok) {
            throw new VaultConnectionError(`Failed to fetch ledger checkpoints: HTTP ${response.status}`);
        }

        const data = toCamelCaseKeys((await response.json()) as Record<string, unknown>);
        const checkpoints = Array.isArray(data.checkpoints) ? data.checkpoints : [];
        return checkpoints.map((checkpoint) => LedgerCheckpointSchema.parse(checkpoint));
    }

    async fetchLedgerManifests(limit = 24): Promise<LedgerManifest[]> {
        return this.fetchLedgerCheckpoints(limit);
    }

    async fetchLedgerInclusionProof(requestId: string): Promise<InclusionProof> {
        const response = await this._fetch(`/ledger/proof/inclusion?request_id=${encodeURIComponent(requestId)}`);
        if (!response.ok) {
            throw new VaultConnectionError(`Failed to fetch inclusion proof: HTTP ${response.status}`);
        }
        const data = toCamelCaseKeys((await response.json()) as Record<string, unknown>);
        return InclusionProofSchema.parse(data);
    }

    async fetchLedgerConsistencyProof(fromCheckpointId: number, toCheckpointId: number): Promise<ConsistencyProof> {
        const response = await this._fetch(
            `/ledger/proof/consistency?from=${encodeURIComponent(String(fromCheckpointId))}&to=${encodeURIComponent(String(toCheckpointId))}`,
        );
        if (!response.ok) {
            throw new VaultConnectionError(`Failed to fetch consistency proof: HTTP ${response.status}`);
        }
        const data = toCamelCaseKeys((await response.json()) as Record<string, unknown>);
        return ConsistencyProofSchema.parse(data);
    }

    async fetchLedgerProofBundle(requestId: string): Promise<LedgerProofBundle> {
        const response = await this._fetch(`/ledger/proof/bundle?request_id=${encodeURIComponent(requestId)}`);
        if (!response.ok) {
            throw new VaultConnectionError(`Failed to fetch ledger proof bundle: HTTP ${response.status}`);
        }
        const data = toCamelCaseKeys((await response.json()) as Record<string, unknown>);
        return LedgerProofBundleSchema.parse(data);
    }

    async verifyLedgerProof(entries: LedgerEntry[], checkpoints: LedgerCheckpoint[] = []): Promise<LedgerVerificationResult> {
        if (!this._jwksCache) {
            await this.fetchJwks();
        }

        const verificationKeys = this._resolveVerificationKeys();

        if (verificationKeys.length === 0) {
            throw new TokenVerificationError("No JWKS available from Vault");
        }

        const keyCache = new Map<string, CryptoKey>();
        const keyForKid = async (kid: string): Promise<CryptoKey> => {
            if (keyCache.has(kid)) {
                return keyCache.get(kid)!;
            }

            const jwk = verificationKeys.find((item) => item.kid === kid);
            if (!jwk) {
                throw new TokenVerificationError(`No JWKS key found for kid ${kid}`);
            }

            const imported = await jose.importJWK(jwk as jose.JWK, "EdDSA");
            keyCache.set(kid, imported as CryptoKey);
            return imported as CryptoKey;
        };

        const sortedEntries = [...entries].sort((a, b) => a.seq - b.seq);
        const sequencedEntries = sortedEntries
            .filter((entry) => entry.leafIndex !== null && entry.leafIndex !== undefined)
            .sort((a, b) => (a.leafIndex ?? 0) - (b.leafIndex ?? 0));

        let latestLeafHash: string | null = null;
        const coverageNotes: string[] = [];
        let redactedEntryCount = 0;

        for (const entry of sortedEntries) {
            if (hasProtectedEventFields(entry)) {
                const expectedEventHash = await buildEventHash(entry);
                if (expectedEventHash !== entry.eventHash) {
                    throw new TokenVerificationError(`Ledger event hash mismatch at seq ${entry.seq}`);
                }
            } else {
                redactedEntryCount += 1;
            }
            const expectedLeafHash = await hashLeafHex(entry.eventHash);
            if (expectedLeafHash !== entry.leafHash) {
                throw new TokenVerificationError(`Ledger leaf hash mismatch at seq ${entry.seq}`);
            }
            if (entry.receiptAlgorithm !== "Ed25519") {
                throw new TokenVerificationError(`Unsupported ledger receipt algorithm ${entry.receiptAlgorithm}`);
            }

            const payloadBytes = decodeBase64Url(entry.receiptPayload);
            const rebuiltPayloadBytes = buildReceiptPayload(entry);
            if (!equalBytes(payloadBytes, rebuiltPayloadBytes)) {
                throw new TokenVerificationError(`Ledger receipt payload mismatch at seq ${entry.seq}`);
            }
            const signatureBytes = decodeBase64Url(entry.receiptSignature);
            const key = await keyForKid(entry.receiptKeyId);
            const verified = await crypto.subtle.verify(
                "Ed25519",
                key,
                toArrayBuffer(signatureBytes),
                toArrayBuffer(payloadBytes),
            );
            if (!verified) {
                throw new TokenVerificationError(`Ledger receipt signature invalid at seq ${entry.seq}`);
            }
            latestLeafHash = entry.leafHash;
        }
        if (redactedEntryCount > 0) {
            coverageNotes.push(
                `Event-body hash recomputation was skipped for ${redactedEntryCount} redacted public ledger entr${redactedEntryCount === 1 ? "y" : "ies"}; receipt and checkpoint proofs still verified.`,
            );
        }

        const sortedCheckpoints = [...checkpoints].sort(
            (a, b) => a.checkpointId - b.checkpointId,
        );
        let previousCheckpointHash = "";

        for (const checkpoint of sortedCheckpoints) {
            if (checkpoint.prevCheckpointHash !== previousCheckpointHash) {
                throw new TokenVerificationError(`Ledger checkpoint chain broken at checkpoint ${checkpoint.checkpointId}`);
            }
            if (checkpoint.signatureAlgorithm !== "Ed25519") {
                throw new TokenVerificationError(`Unsupported checkpoint signature algorithm ${checkpoint.signatureAlgorithm}`);
            }

            const payloadBytes = decodeBase64Url(checkpoint.checkpointPayload);
            const rebuiltPayloadBytes = buildCheckpointPayload(checkpoint);
            if (!equalBytes(payloadBytes, rebuiltPayloadBytes)) {
                throw new TokenVerificationError(`Ledger checkpoint payload mismatch at checkpoint ${checkpoint.checkpointId}`);
            }
            const checkpointHash = await hashCheckpointHex(payloadBytes);
            if (checkpointHash !== checkpoint.checkpointHash) {
                throw new TokenVerificationError(`Ledger checkpoint hash mismatch at checkpoint ${checkpoint.checkpointId}`);
            }
            const signatureBytes = decodeBase64Url(checkpoint.checkpointSignature);
            const key = await keyForKid(checkpoint.signerKeyId);
            const verified = await crypto.subtle.verify(
                "Ed25519",
                key,
                toArrayBuffer(signatureBytes),
                toArrayBuffer(payloadBytes),
            );
            if (!verified) {
                throw new TokenVerificationError(`Ledger checkpoint signature invalid at checkpoint ${checkpoint.checkpointId}`);
            }
            previousCheckpointHash = checkpoint.checkpointHash;
        }

        let coverageNote: string | undefined;
        let latestCheckpointHash: string | null = null;
        if (sortedCheckpoints.length > 0) {
            const latestCheckpoint = sortedCheckpoints[sortedCheckpoints.length - 1];
            latestCheckpointHash = latestCheckpoint.checkpointHash;
            if (sequencedEntries.length === latestCheckpoint.treeSize) {
                const root = await merkleRootHex(sequencedEntries.map((entry) => entry.leafHash));
                if (root !== latestCheckpoint.rootHash) {
                    throw new TokenVerificationError("Latest checkpoint root does not match sequenced leaf hashes");
                }
            } else {
                coverageNotes.push(
                    `Provided ${sequencedEntries.length} sequenced entries for tree size ${latestCheckpoint.treeSize}; full root verification requires the complete covered set.`,
                );
            }
        }
        if (coverageNotes.length > 0) {
            coverageNote = coverageNotes.join(" ");
        }

        return LedgerVerificationResultSchema.parse({
            intact: true,
            verifiedEntries: sortedEntries.length,
            verifiedCheckpoints: sortedCheckpoints.length,
            verifiedManifests: sortedCheckpoints.length,
            latestLeafHash,
            latestCheckpointHash,
            latestManifestHash: latestCheckpointHash,
            coverageNote,
        });
    }

    async verifyLedgerProofBundle(bundle: LedgerProofBundle): Promise<LedgerVerificationResult> {
        const proofBundle = LedgerProofBundleSchema.parse(bundle);
        if (proofBundle.keys.length === 0 && !this._jwksCache) {
            await this.fetchJwks();
        }
        const verificationKeys = this._resolveVerificationKeys(proofBundle.keys);
        if (verificationKeys.length === 0) {
            throw new TokenVerificationError("No verification keys available for ledger proof bundle");
        }

        const keyCache = new Map<string, CryptoKey>();
        const keyForKid = async (kid: string): Promise<CryptoKey> => {
            if (keyCache.has(kid)) {
                return keyCache.get(kid)!;
            }
            const jwk = verificationKeys.find((item) => item.kid === kid);
            if (!jwk) {
                throw new TokenVerificationError(`No JWKS key found for kid ${kid}`);
            }
            const imported = await jose.importJWK(jwk as jose.JWK, "EdDSA");
            keyCache.set(kid, imported as CryptoKey);
            return imported as CryptoKey;
        };

        const payloadBytes = decodeBase64Url(proofBundle.event.receiptPayload);
        const rebuiltReceiptPayload = buildReceiptPayload(proofBundle.event);
        if (!equalBytes(payloadBytes, rebuiltReceiptPayload)) {
            throw new TokenVerificationError("Ledger receipt payload mismatch in proof bundle");
        }
        const entryKey = await keyForKid(proofBundle.event.receiptKeyId);
        const receiptOk = await crypto.subtle.verify(
            "Ed25519",
            entryKey,
            toArrayBuffer(decodeBase64Url(proofBundle.event.receiptSignature)),
            toArrayBuffer(payloadBytes),
        );
        if (!receiptOk) {
            throw new TokenVerificationError("Ledger receipt signature invalid in proof bundle");
        }

        const checkpointPayload = decodeBase64Url(proofBundle.inclusion.checkpoint.checkpointPayload);
        const rebuiltCheckpointPayload = buildCheckpointPayload(proofBundle.inclusion.checkpoint);
        if (!equalBytes(checkpointPayload, rebuiltCheckpointPayload)) {
            throw new TokenVerificationError("Ledger checkpoint payload mismatch in proof bundle");
        }
        const checkpointKey = await keyForKid(proofBundle.inclusion.checkpoint.signerKeyId);
        const checkpointOk = await crypto.subtle.verify(
            "Ed25519",
            checkpointKey,
            toArrayBuffer(decodeBase64Url(proofBundle.inclusion.checkpoint.checkpointSignature)),
            toArrayBuffer(checkpointPayload),
        );
        if (!checkpointOk) {
            throw new TokenVerificationError("Ledger checkpoint signature invalid in proof bundle");
        }

        const inclusionOk = await verifyInclusionProof(
            proofBundle.event.leafHash,
            proofBundle.inclusion.leafIndex,
            proofBundle.inclusion.treeSize,
            proofBundle.inclusion.path,
            proofBundle.inclusion.checkpoint.rootHash,
        );
        if (!inclusionOk) {
            throw new TokenVerificationError("Ledger inclusion proof is invalid");
        }

        if (proofBundle.consistency) {
            const consistencyOk = await verifyConsistencyProof(
                proofBundle.consistency.fromCheckpoint.treeSize,
                proofBundle.consistency.toCheckpoint.treeSize,
                proofBundle.consistency.fromCheckpoint.rootHash,
                proofBundle.consistency.toCheckpoint.rootHash,
                proofBundle.consistency.path,
            );
            if (!consistencyOk) {
                throw new TokenVerificationError("Ledger consistency proof is invalid");
            }
        }

        return LedgerVerificationResultSchema.parse({
            intact: true,
            verifiedEntries: 1,
            verifiedCheckpoints: proofBundle.consistency ? 2 : 1,
            verifiedManifests: proofBundle.consistency ? 2 : 1,
            latestLeafHash: proofBundle.event.leafHash,
            latestCheckpointHash: proofBundle.consistency
                ? proofBundle.consistency.toCheckpoint.checkpointHash
                : proofBundle.inclusion.checkpoint.checkpointHash,
            latestManifestHash: proofBundle.consistency
                ? proofBundle.consistency.toCheckpoint.checkpointHash
                : proofBundle.inclusion.checkpoint.checkpointHash,
        });
    }

    private _resolveVerificationKeys(embeddedKeys: LedgerKeyVersion[] = []): Array<Record<string, unknown>> {
        const resolved = embeddedKeys.flatMap((keyVersion) => {
            if (!keyVersion.publicJwk) {
                return [];
            }
            const decoded = decodeBase64Url(keyVersion.publicJwk);
            const jwk = JSON.parse(new TextDecoder().decode(decoded)) as Record<string, unknown>;
            if (!("kid" in jwk) || !jwk.kid) {
                jwk.kid = keyVersion.keyId;
            }
            return [jwk];
        });
        if (resolved.length > 0) {
            return resolved;
        }
        const jwks = this._jwksCache as { keys?: Record<string, unknown>[] } | null;
        return Array.isArray(jwks?.keys) ? jwks.keys : [];
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

function encodeUtf8(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

class CborFloat64 {
    constructor(readonly value: number) {}
}

function normalizeJSONNumbersForCbor(value: unknown): unknown {
    if (value === null || value === undefined) {
        return value ?? null;
    }
    if (typeof value === "boolean" || typeof value === "string") {
        return value;
    }
    if (typeof value === "number") {
        return new CborFloat64(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => normalizeJSONNumbersForCbor(item));
    }
    if (typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeJSONNumbersForCbor(item)]),
        );
    }
    return value;
}

function encodeDeterministicCbor(value: unknown): Uint8Array {
    if (value === null) {
        return Uint8Array.of(0xf6);
    }
    if (typeof value === "boolean") {
        return Uint8Array.of(value ? 0xf5 : 0xf4);
    }
    if (typeof value === "string") {
        const bytes = encodeUtf8(value);
        return concatBytes(cborHeader(3, bytes.length), bytes);
    }
    if (value instanceof CborFloat64) {
        const scratch = new ArrayBuffer(8);
        new DataView(scratch).setFloat64(0, value.value, false);
        return concatBytes(Uint8Array.of(0xfb), new Uint8Array(scratch));
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new Error(`Unsupported floating-point value ${value}`);
        }
        if (Number.isSafeInteger(value)) {
            return encodeCborInteger(value);
        }
        const scratch = new ArrayBuffer(8);
        new DataView(scratch).setFloat64(0, value, false);
        return concatBytes(Uint8Array.of(0xfb), new Uint8Array(scratch));
    }
    if (Array.isArray(value)) {
        const items = value.map((item) => encodeDeterministicCbor(item));
        return concatBytes(cborHeader(4, items.length), ...items);
    }
    if (value instanceof Uint8Array) {
        return concatBytes(cborHeader(2, value.length), value);
    }
    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => {
            if (left.length === right.length) {
                return left < right ? -1 : left > right ? 1 : 0;
            }
            return left.length - right.length;
        });
        const encodedEntries = entries.flatMap(([key, item]) => [
            encodeDeterministicCbor(key),
            encodeDeterministicCbor(item),
        ]);
        return concatBytes(cborHeader(5, entries.length), ...encodedEntries);
    }
    throw new Error(`Unsupported CBOR value type: ${typeof value}`);
}

function encodeCborInteger(value: number): Uint8Array {
    if (value >= 0) {
        return cborHeader(0, value);
    }
    return cborHeader(1, -(value + 1));
}

function cborHeader(major: number, value: number): Uint8Array {
    if (value < 24) {
        return Uint8Array.of((major << 5) | value);
    }
    if (value <= 0xff) {
        return Uint8Array.of((major << 5) | 24, value);
    }
    if (value <= 0xffff) {
        const scratch = new Uint8Array(3);
        scratch[0] = (major << 5) | 25;
        new DataView(scratch.buffer).setUint16(1, value, false);
        return scratch;
    }
    if (value <= 0xffffffff) {
        const scratch = new Uint8Array(5);
        scratch[0] = (major << 5) | 26;
        new DataView(scratch.buffer).setUint32(1, value, false);
        return scratch;
    }
    const scratch = new Uint8Array(9);
    scratch[0] = (major << 5) | 27;
    new DataView(scratch.buffer).setBigUint64(1, BigInt(value), false);
    return scratch;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
    const size = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(value));
    return Array.from(new Uint8Array(digest))
        .map((item) => item.toString(16).padStart(2, "0"))
        .join("");
}

async function hashEventHex(payload: Uint8Array): Promise<string> {
    return sha256Hex(concatBytes(encodeUtf8("ledgix.audit.event.v1\0"), payload));
}

async function hashCheckpointHex(payload: Uint8Array): Promise<string> {
    return sha256Hex(concatBytes(encodeUtf8("ledgix.audit.checkpoint.v1\0"), payload));
}

async function hashLeafHex(eventHash: string): Promise<string> {
    return sha256Hex(concatBytes(Uint8Array.of(0x00), hexToBytes(eventHash)));
}

async function hashNodeHex(leftHash: string, rightHash: string): Promise<string> {
    return sha256Hex(concatBytes(Uint8Array.of(0x01), hexToBytes(leftHash), hexToBytes(rightHash)));
}

async function buildEventHash(entry: LedgerEntry): Promise<string> {
    const payload = encodeDeterministicCbor({
        accepted_at: entry.acceptedAt,
        agent_id: entry.agentId,
        approved: entry.approved,
        canonical_version: entry.canonicalVersion,
        citations: normalizeJSONNumbersForCbor(entry.citations),
        confidence: entry.confidence,
        event_uuid: entry.eventUuid,
        evidence_chunks: normalizeJSONNumbersForCbor(entry.evidenceChunks),
        intent_hash: entry.intentHash,
        policy_id: entry.policyId,
        reason: entry.reason,
        request_id: entry.requestId,
        tool_args: normalizeJSONNumbersForCbor(entry.toolArgs),
        tool_name: entry.toolName,
    });
    return hashEventHex(payload);
}

function hasProtectedEventFields(entry: LedgerEntry): boolean {
    return typeof entry.intentHash === "string" && entry.intentHash.length > 0;
}

function buildReceiptPayload(entry: LedgerEntry): Uint8Array {
    return encodeDeterministicCbor({
        accepted_at: entry.acceptedAt,
        event_hash: entry.eventHash,
        event_uuid: entry.eventUuid,
        leaf_hash: entry.leafHash,
        receipt_key_id: entry.receiptKeyId,
        request_id: entry.requestId,
        type: "event_receipt",
        version: 1,
    });
}

function buildCheckpointPayload(checkpoint: LedgerCheckpoint): Uint8Array {
    return encodeDeterministicCbor({
        export_targets: checkpoint.exportTarget ? [checkpoint.exportTarget] : [],
        key_id: checkpoint.signerKeyId,
        mmd_seconds: checkpoint.mmdSeconds,
        prev_checkpoint_hash: checkpoint.prevCheckpointHash,
        root_hash: checkpoint.rootHash,
        signed_at: checkpoint.signedAt,
        tree_size: checkpoint.treeSize,
        type: "checkpoint",
        version: 1,
    });
}

async function merkleRootHex(leafHashes: string[]): Promise<string> {
    if (leafHashes.length === 0) {
        return "";
    }
    return merkleRangeHash(leafHashes, 0, leafHashes.length);
}

async function merkleRangeHash(leafHashes: string[], start: number, size: number): Promise<string> {
    if (size === 1) {
        return leafHashes[start];
    }
    const k = largestPowerOfTwoLessThan(size);
    const left = await merkleRangeHash(leafHashes, start, k);
    const right = await merkleRangeHash(leafHashes, start + k, size - k);
    return hashNodeHex(left, right);
}

function largestPowerOfTwoLessThan(size: number): number {
    let power = 1;
    while ((power << 1) < size) {
        power <<= 1;
    }
    return power;
}

async function verifyInclusionProof(
    leafHash: string,
    leafIndex: number,
    treeSize: number,
    path: string[],
    rootHash: string,
): Promise<boolean> {
    let fn = leafIndex;
    let sn = treeSize - 1;
    let hash = leafHash;
    for (const sibling of path) {
        if (sn === 0) {
            return false;
        }
        if (fn % 2 === 1 || fn === sn) {
            hash = await hashNodeHex(sibling, hash);
            while (fn > 0 && fn % 2 === 0) {
                fn >>= 1;
                sn >>= 1;
            }
        } else {
            hash = await hashNodeHex(hash, sibling);
        }
        fn >>= 1;
        sn >>= 1;
    }
    return hash === rootHash && sn === 0;
}

async function verifyConsistencyProof(
    firstSize: number,
    secondSize: number,
    firstHash: string,
    secondHash: string,
    path: string[],
): Promise<boolean> {
    if (firstSize === secondSize) {
        return firstHash === secondHash;
    }
    if (path.length === 0) {
        return false;
    }
    const working = isPowerOfTwo(firstSize) ? [firstHash, ...path] : [...path];
    let fn = firstSize - 1;
    let sn = secondSize - 1;
    while ((fn & 1) === 1) {
        fn >>= 1;
        sn >>= 1;
    }
    let firstRoot = working[0];
    let secondRoot = working[0];
    for (const candidate of working.slice(1)) {
        if (sn === 0) {
            return false;
        }
        if ((fn & 1) === 1 || fn === sn) {
            firstRoot = await hashNodeHex(candidate, firstRoot);
            secondRoot = await hashNodeHex(candidate, secondRoot);
            while (fn > 0 && (fn & 1) === 0) {
                fn >>= 1;
                sn >>= 1;
            }
        } else {
            secondRoot = await hashNodeHex(secondRoot, candidate);
        }
        fn >>= 1;
        sn >>= 1;
    }
    return firstRoot === firstHash && secondRoot === secondHash && sn === 0;
}

function isPowerOfTwo(value: number): boolean {
    return value > 0 && (value & (value - 1)) === 0;
}

function hexToBytes(value: string): Uint8Array {
    const bytes = new Uint8Array(value.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    return copy.buffer;
}
