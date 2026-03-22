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

        for (const entry of sortedEntries) {
            const expectedEventHash = await buildEventHash(entry);
            if (expectedEventHash !== entry.eventHash) {
                throw new TokenVerificationError(`Ledger event hash mismatch at seq ${entry.seq}`);
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
                coverageNote = `Provided ${sequencedEntries.length} sequenced entries for tree size ${latestCheckpoint.treeSize}; full root verification requires the complete covered set.`;
            }
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
        citations: entry.citations,
        confidence: entry.confidence,
        event_uuid: entry.eventUuid,
        evidence_chunks: entry.evidenceChunks,
        intent_hash: entry.intentHash,
        policy_id: entry.policyId,
        reason: entry.reason,
        request_id: entry.requestId,
        tool_args: entry.toolArgs,
        tool_name: entry.toolName,
    });
    return hashEventHex(payload);
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
