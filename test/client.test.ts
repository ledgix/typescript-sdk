// Ledgix ALCV — Client Tests

import { describe, expect, it, beforeEach } from "vitest";
import * as jose from "jose";

import { LedgixClient } from "../src/client.js";
import {
    ClearanceDeniedError,
    PolicyRegistrationError,
    TokenVerificationError,
    VaultConnectionError,
} from "../src/exceptions.js";
import type { ClearanceRequest, PolicyRegistration } from "../src/models.js";
import { server, http, HttpResponse } from "./setup.js";
import {
    approvedResponse,
    buildJwksResponse,
    createExpiredJwt,
    createRetryTestClient,
    createSampleJwt,
    createTestClient,
    deniedResponse,
    generateTestKeys,
    policyResponse,
    type TestKeys,
} from "./helpers.js";
import type { LedgerCheckpoint, LedgerEntry } from "../src/models.js";

// ──────────────────────────────────────────────────────────────────────
// Clearance
// ──────────────────────────────────────────────────────────────────────

describe("LedgixClient.requestClearance", () => {
    let client: LedgixClient;
    let keys: TestKeys;
    let sampleToken: string;

    beforeEach(async () => {
        client = createTestClient();
        keys = await generateTestKeys();
        sampleToken = await createSampleJwt(keys.privateKey);
    });

    it("should return approved clearance", async () => {
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const request: ClearanceRequest = {
            toolName: "stripe_refund",
            toolArgs: { amount: 45 },
            agentId: "test-agent",
            sessionId: "test-session",
            context: {},
        };

        const result = await client.requestClearance(request);
        expect(result.approved).toBe(true);
        expect(result.token).not.toBeNull();
        expect(result.requestId).toBe("req-001");
    });

    it("should throw ClearanceDeniedError when denied", async () => {
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json(deniedResponse());
            }),
        );

        const request: ClearanceRequest = {
            toolName: "stripe_refund",
            toolArgs: { amount: 5000 },
            agentId: "test-agent",
            sessionId: "",
            context: {},
        };

        await expect(client.requestClearance(request)).rejects.toThrow(ClearanceDeniedError);

        try {
            await client.requestClearance(request);
        } catch (e) {
            const err = e as ClearanceDeniedError;
            expect(err.reason).toContain("exceeds $100");
            expect(err.requestId).toBe("req-002");
        }
    });

    it("should throw VaultConnectionError on network failure", async () => {
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.error();
            }),
        );

        const request: ClearanceRequest = {
            toolName: "stripe_refund",
            toolArgs: { amount: 45 },
            agentId: "test-agent",
            sessionId: "",
            context: {},
        };

        await expect(client.requestClearance(request)).rejects.toThrow(VaultConnectionError);
    });

    it("should throw VaultConnectionError on HTTP 500", async () => {
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return new HttpResponse("Internal Server Error", { status: 500 });
            }),
        );

        const request: ClearanceRequest = {
            toolName: "stripe_refund",
            toolArgs: { amount: 45 },
            agentId: "test-agent",
            sessionId: "",
            context: {},
        };

        await expect(client.requestClearance(request)).rejects.toThrow(VaultConnectionError);

        try {
            await client.requestClearance(request);
        } catch (e) {
            expect((e as Error).message).toContain("500");
        }
    });

    it("should send correct headers", async () => {
        let capturedHeaders: Record<string, string> = {};

        server.use(
            http.post("https://vault.test/request-clearance", ({ request }) => {
                capturedHeaders = Object.fromEntries(request.headers.entries());
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const request: ClearanceRequest = {
            toolName: "test_tool",
            toolArgs: {},
            agentId: "test-agent",
            sessionId: "",
            context: {},
        };

        await client.requestClearance(request);

        expect(capturedHeaders["x-vault-api-key"]).toBe("test-api-key");
        expect(capturedHeaders["content-type"]).toBe("application/json");
    });

    it("should send correct snake_case payload", async () => {
        let capturedBody: Record<string, unknown> = {};

        server.use(
            http.post("https://vault.test/request-clearance", async ({ request }) => {
                capturedBody = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const request: ClearanceRequest = {
            toolName: "stripe_refund",
            toolArgs: { amount: 99, reason: "late" },
            agentId: "my-agent",
            sessionId: "sess-123",
            context: {},
        };

        await client.requestClearance(request);

        expect(capturedBody.tool_name).toBe("stripe_refund");
        expect((capturedBody.tool_args as Record<string, unknown>).amount).toBe(99);
        expect(capturedBody.agent_id).toBe("my-agent");
    });

    it("should poll processing clearance until approved", async () => {
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json(
                    {
                        status: "processing",
                        approved: false,
                        token: null,
                        reason: "Queued",
                        request_id: "req-processing-001",
                        confidence: 0,
                        minimum_confidence_score: 0.8,
                    },
                    { status: 202 },
                );
            }),
            http.get("https://vault.test/clearance-status/req-processing-001", () => {
                return HttpResponse.json({ ...approvedResponse(sampleToken), request_id: "req-processing-001" });
            }),
        );

        const request: ClearanceRequest = {
            toolName: "stripe_refund",
            toolArgs: { amount: 45 },
            agentId: "test-agent",
            sessionId: "test-session",
            context: {},
        };

        const result = await client.requestClearance(request);
        expect(result.approved).toBe(true);
        expect(result.requestId).toBe("req-processing-001");
    });
});

// ──────────────────────────────────────────────────────────────────────
// Policy registration
// ──────────────────────────────────────────────────────────────────────

describe("LedgixClient.registerPolicy", () => {
    let client: LedgixClient;

    beforeEach(() => {
        client = createTestClient();
    });

    it("should register a policy", async () => {
        server.use(
            http.post("https://vault.test/register-policy", () => {
                return HttpResponse.json(policyResponse());
            }),
        );

        const policy: PolicyRegistration = {
            policyId: "refund-policy",
            description: "Refund rules",
            rules: ["Refunds up to $100"],
            tools: [],
        };

        const result = await client.registerPolicy(policy);
        expect(result.policyId).toBe("refund-policy");
        expect(result.status).toBe("registered");
    });

    it("should throw PolicyRegistrationError on HTTP error", async () => {
        server.use(
            http.post("https://vault.test/register-policy", () => {
                return new HttpResponse("Bad Request", { status: 400 });
            }),
        );

        const policy: PolicyRegistration = {
            policyId: "bad",
            description: "",
            rules: [],
            tools: [],
        };

        await expect(client.registerPolicy(policy)).rejects.toThrow(PolicyRegistrationError);
    });
});

describe("LedgixClient.verifyLedgerProof", () => {
    it("verifies signed ledger entries and checkpoints offline", async () => {
        const client = createTestClient();
        const keys = await generateTestKeys();
        const jwks = await buildJwksResponse(keys.publicKey);

        server.use(
            http.get("https://vault.test/.well-known/jwks.json", () => HttpResponse.json(jwks)),
        );

        const baseEntry: LedgerEntry = {
            seq: 1,
            eventUuid: "evt-1",
            requestId: "req-1",
            agentId: "agent-1",
            policyId: "policy-1",
            intentHash: "intent-1",
            toolName: "stripe_refund",
            toolArgs: { amount: 45 },
            reason: "approved",
            citations: [],
            evidenceChunks: [],
            confidence: 0.91,
            approved: true,
            acceptedAt: "2026-03-15T12:00:00Z",
            canonicalVersion: 1,
            eventHash: "",
            leafHash: "",
            leafIndex: 0,
            checkpointId: 1,
            receiptAlgorithm: "Ed25519",
            receiptKeyId: "test-key-001",
            receiptSignature: "",
            receiptPayload: "",
        };
        const eventHash = await buildEventHashForTest(baseEntry);
        const leafHash = await hashLeafForTest(eventHash);
        const entryReceiptPayload = buildReceiptPayloadForTest({
            ...baseEntry,
            eventHash,
            leafHash,
        });
        const entrySignature = await crypto.subtle.sign("Ed25519", keys.privateKey, entryReceiptPayload);
        const entries: LedgerEntry[] = [
            {
                ...baseEntry,
                eventHash,
                leafHash,
                receiptSignature: encodeBase64Url(new Uint8Array(entrySignature)),
                receiptPayload: encodeBase64Url(entryReceiptPayload),
            },
        ];

        const checkpointBase: LedgerCheckpoint = {
            checkpointId: 1,
            microblockId: 1,
            treeSize: 1,
            rootHash: leafHash,
            checkpointHash: "",
            prevCheckpointHash: "",
            signatureAlgorithm: "Ed25519",
            signerKeyId: "test-key-001",
            checkpointSignature: "",
            checkpointPayload: "",
            signedAt: "2026-03-15T12:05:00Z",
            mmdSeconds: 30,
            exportTarget: "",
            exportUri: "",
            exportStatus: "",
        };
        const checkpointPayload = buildCheckpointPayloadForTest(checkpointBase);
        const checkpointHash = await hashCheckpointPayloadForTest(checkpointPayload);
        const checkpointSignature = await crypto.subtle.sign("Ed25519", keys.privateKey, checkpointPayload);
        const checkpoints: LedgerCheckpoint[] = [
            {
                ...checkpointBase,
                checkpointHash,
                checkpointSignature: encodeBase64Url(new Uint8Array(checkpointSignature)),
                checkpointPayload: encodeBase64Url(checkpointPayload),
            },
        ];

        const result = await client.verifyLedgerProof(entries, checkpoints);
        expect(result.intact).toBe(true);
        expect(result.verifiedEntries).toBe(1);
        expect(result.verifiedCheckpoints).toBe(1);
        expect(result.verifiedManifests).toBe(1);
        expect(result.latestLeafHash).toBe(leafHash);
    });

    it("treats redacted public ledger entries as partial coverage instead of failure", async () => {
        const client = createTestClient();
        const keys = await generateTestKeys();
        const jwks = await buildJwksResponse(keys.publicKey);

        server.use(
            http.get("https://vault.test/.well-known/jwks.json", () => HttpResponse.json(jwks)),
        );

        const fullEntry: LedgerEntry = {
            seq: 1,
            eventUuid: "evt-1",
            requestId: "req-1",
            agentId: "agent-1",
            policyId: "policy-1",
            intentHash: "intent-1",
            toolName: "stripe_refund",
            toolArgs: { amount: 45 },
            reason: "approved",
            citations: [],
            evidenceChunks: [],
            confidence: 0.91,
            approved: true,
            acceptedAt: "2026-03-15T12:00:00Z",
            canonicalVersion: 1,
            eventHash: "",
            leafHash: "",
            leafIndex: 0,
            checkpointId: 1,
            receiptAlgorithm: "Ed25519",
            receiptKeyId: "test-key-001",
            receiptSignature: "",
            receiptPayload: "",
        };
        const eventHash = await buildEventHashForTest(fullEntry);
        const leafHash = await hashLeafForTest(eventHash);
        const entryReceiptPayload = buildReceiptPayloadForTest({
            ...fullEntry,
            eventHash,
            leafHash,
        });
        const entrySignature = await crypto.subtle.sign("Ed25519", keys.privateKey, entryReceiptPayload);
        const publicEntry: LedgerEntry = {
            ...fullEntry,
            intentHash: "",
            toolArgs: {},
            eventHash,
            leafHash,
            receiptSignature: encodeBase64Url(new Uint8Array(entrySignature)),
            receiptPayload: encodeBase64Url(entryReceiptPayload),
        };

        const checkpointBase: LedgerCheckpoint = {
            checkpointId: 1,
            microblockId: 1,
            treeSize: 1,
            rootHash: leafHash,
            checkpointHash: "",
            prevCheckpointHash: "",
            signatureAlgorithm: "Ed25519",
            signerKeyId: "test-key-001",
            checkpointSignature: "",
            checkpointPayload: "",
            signedAt: "2026-03-15T12:05:00Z",
            mmdSeconds: 30,
            exportTarget: "",
            exportUri: "",
            exportStatus: "",
        };
        const checkpointPayload = buildCheckpointPayloadForTest(checkpointBase);
        const checkpointHash = await hashCheckpointPayloadForTest(checkpointPayload);
        const checkpointSignature = await crypto.subtle.sign("Ed25519", keys.privateKey, checkpointPayload);
        const checkpoints: LedgerCheckpoint[] = [
            {
                ...checkpointBase,
                checkpointHash,
                checkpointSignature: encodeBase64Url(new Uint8Array(checkpointSignature)),
                checkpointPayload: encodeBase64Url(checkpointPayload),
            },
        ];

        const result = await client.verifyLedgerProof([publicEntry], checkpoints);
        expect(result.intact).toBe(true);
        expect(result.verifiedEntries).toBe(1);
        expect(result.coverageNote).toContain("redacted public ledger entry");
    });
});

function encodeBase64Url(value: Uint8Array): string {
    return Buffer.from(value)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function toHex(value: Uint8Array): string {
    return Array.from(value)
        .map((item) => item.toString(16).padStart(2, "0"))
        .join("");
}

function encodeUtf8(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
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

function encodeCborInteger(value: number): Uint8Array {
    if (value >= 0) {
        return cborHeader(0, value);
    }
    return cborHeader(1, -(value + 1));
}

class TestCborFloat64 {
    constructor(readonly value: number) {}
}

function normalizeJSONNumbersForTestCbor(value: unknown): unknown {
    if (value === null || value === undefined) {
        return value ?? null;
    }
    if (typeof value === "boolean" || typeof value === "string") {
        return value;
    }
    if (typeof value === "number") {
        return new TestCborFloat64(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => normalizeJSONNumbersForTestCbor(item));
    }
    if (typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeJSONNumbersForTestCbor(item)]),
        );
    }
    return value;
}

function encodeDeterministicCborForTest(value: unknown): Uint8Array {
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
    if (value instanceof TestCborFloat64) {
        const scratch = new ArrayBuffer(8);
        new DataView(scratch).setFloat64(0, value.value, false);
        return concatBytes(Uint8Array.of(0xfb), new Uint8Array(scratch));
    }
    if (typeof value === "number") {
        if (Number.isSafeInteger(value)) {
            return encodeCborInteger(value);
        }
        const scratch = new ArrayBuffer(8);
        new DataView(scratch).setFloat64(0, value, false);
        return concatBytes(Uint8Array.of(0xfb), new Uint8Array(scratch));
    }
    if (Array.isArray(value)) {
        const items = value.map((item) => encodeDeterministicCborForTest(item));
        return concatBytes(cborHeader(4, items.length), ...items);
    }
    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => {
            if (left.length === right.length) {
                return left < right ? -1 : left > right ? 1 : 0;
            }
            return left.length - right.length;
        });
        const encodedEntries = entries.flatMap(([key, item]) => [
            encodeDeterministicCborForTest(key),
            encodeDeterministicCborForTest(item),
        ]);
        return concatBytes(cborHeader(5, entries.length), ...encodedEntries);
    }
    throw new Error(`Unsupported test CBOR value type: ${typeof value}`);
}

async function sha256HexForTest(value: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", value);
    return toHex(new Uint8Array(digest));
}

async function buildEventHashForTest(entry: LedgerEntry): Promise<string> {
    const payload = encodeDeterministicCborForTest({
        accepted_at: entry.acceptedAt,
        agent_id: entry.agentId,
        approved: entry.approved,
        canonical_version: entry.canonicalVersion,
        citations: normalizeJSONNumbersForTestCbor(entry.citations),
        confidence: entry.confidence,
        event_uuid: entry.eventUuid,
        evidence_chunks: normalizeJSONNumbersForTestCbor(entry.evidenceChunks),
        intent_hash: entry.intentHash,
        policy_id: entry.policyId,
        reason: entry.reason,
        request_id: entry.requestId,
        tool_args: normalizeJSONNumbersForTestCbor(entry.toolArgs),
        tool_name: entry.toolName,
    });
    return sha256HexForTest(concatBytes(encodeUtf8("ledgix.audit.event.v1\0"), payload));
}

async function hashLeafForTest(eventHash: string): Promise<string> {
    return sha256HexForTest(concatBytes(Uint8Array.of(0x00), Uint8Array.from(Buffer.from(eventHash, "hex"))));
}

function buildReceiptPayloadForTest(entry: LedgerEntry): Uint8Array {
    return encodeDeterministicCborForTest({
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

function buildCheckpointPayloadForTest(checkpoint: LedgerCheckpoint): Uint8Array {
    return encodeDeterministicCborForTest({
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

async function hashCheckpointPayloadForTest(payload: Uint8Array): Promise<string> {
    return sha256HexForTest(concatBytes(encodeUtf8("ledgix.audit.checkpoint.v1\0"), payload));
}

// ──────────────────────────────────────────────────────────────────────
// JWKS + Token verification
// ──────────────────────────────────────────────────────────────────────

describe("LedgixClient token verification", () => {
    let client: LedgixClient;
    let keys: TestKeys;

    beforeEach(async () => {
        client = createTestClient();
        keys = await generateTestKeys();
    });

    it("should fetch JWKS", async () => {
        const jwks = await buildJwksResponse(keys.publicKey);

        server.use(
            http.get("https://vault.test/.well-known/jwks.json", () => {
                return HttpResponse.json(jwks);
            }),
        );

        const result = await client.fetchJwks();
        expect(result).toHaveProperty("keys");
        expect((result as { keys: unknown[] }).keys).toHaveLength(1);
    });

    it("should verify a valid token", async () => {
        const jwks = await buildJwksResponse(keys.publicKey);
        const token = await createSampleJwt(keys.privateKey);

        server.use(
            http.get("https://vault.test/.well-known/jwks.json", () => {
                return HttpResponse.json(jwks);
            }),
        );

        const decoded = await client.verifyToken(token);
        expect(decoded.sub).toBe("clearance");
        expect(decoded.tool).toBe("stripe_refund");
    });

    it("should throw TokenVerificationError for expired token", async () => {
        const jwks = await buildJwksResponse(keys.publicKey);
        const token = await createExpiredJwt(keys.privateKey);

        server.use(
            http.get("https://vault.test/.well-known/jwks.json", () => {
                return HttpResponse.json(jwks);
            }),
        );

        await expect(client.verifyToken(token)).rejects.toThrow(TokenVerificationError);

        try {
            await client.verifyToken(token);
        } catch (e) {
            expect((e as Error).message).toContain("expired");
        }
    });

    it("should throw TokenVerificationError for invalid token", async () => {
        const jwks = await buildJwksResponse(keys.publicKey);

        server.use(
            http.get("https://vault.test/.well-known/jwks.json", () => {
                return HttpResponse.json(jwks);
            }),
        );

        await expect(client.verifyToken("not.a.valid.token")).rejects.toThrow(
            TokenVerificationError,
        );
    });

    it("should throw TokenVerificationError when JWKS has no keys", async () => {
        server.use(
            http.get("https://vault.test/.well-known/jwks.json", () => {
                return HttpResponse.json({ keys: [] });
            }),
        );

        await expect(client.verifyToken("some.token.here")).rejects.toThrow(
            TokenVerificationError,
        );

        try {
            await client.verifyToken("some.token.here");
        } catch (e) {
            expect((e as Error).message).toContain("no keys");
        }
    });

    it("should auto-verify JWT when verifyJwt is true", async () => {
        const clientWithJwt = createTestClient({ verifyJwt: true });
        const jwks = await buildJwksResponse(keys.publicKey);
        const token = await createSampleJwt(keys.privateKey);

        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json(approvedResponse(token));
            }),
            http.get("https://vault.test/.well-known/jwks.json", () => {
                return HttpResponse.json(jwks);
            }),
        );

        const request: ClearanceRequest = {
            toolName: "stripe_refund",
            toolArgs: { amount: 45 },
            agentId: "test-agent",
            sessionId: "",
            context: {},
        };

        const result = await clientWithJwt.requestClearance(request);
        expect(result.approved).toBe(true);
    });
});

// ──────────────────────────────────────────────────────────────────────
// Retry behaviour
// ──────────────────────────────────────────────────────────────────────

describe("LedgixClient retry", () => {
    let keys: TestKeys;
    let sampleToken: string;

    beforeEach(async () => {
        keys = await generateTestKeys();
        sampleToken = await createSampleJwt(keys.privateKey);
    });

    it("should retry on network error and succeed", async () => {
        const client = createRetryTestClient(2);
        let callCount = 0;

        server.use(
            http.post("https://vault.test/request-clearance", () => {
                callCount++;
                if (callCount < 3) return HttpResponse.error();
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const request: ClearanceRequest = {
            toolName: "stripe_refund",
            toolArgs: { amount: 45 },
            agentId: "test-agent",
            sessionId: "",
            context: {},
        };

        const result = await client.requestClearance(request);
        expect(result.approved).toBe(true);
        expect(callCount).toBe(3);
    });

    it("should retry on 503 and succeed", async () => {
        const client = createRetryTestClient(2);
        let callCount = 0;

        server.use(
            http.post("https://vault.test/request-clearance", () => {
                callCount++;
                if (callCount < 2) return new HttpResponse("Service Unavailable", { status: 503 });
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const request: ClearanceRequest = {
            toolName: "stripe_refund",
            toolArgs: { amount: 45 },
            agentId: "test-agent",
            sessionId: "",
            context: {},
        };

        const result = await client.requestClearance(request);
        expect(result.approved).toBe(true);
        expect(callCount).toBe(2);
    });

    it("should throw VaultConnectionError after exhausting retries", async () => {
        const client = createRetryTestClient(2);

        server.use(
            http.post("https://vault.test/request-clearance", () => HttpResponse.error()),
        );

        const request: ClearanceRequest = {
            toolName: "stripe_refund",
            toolArgs: {},
            agentId: "test-agent",
            sessionId: "",
            context: {},
        };

        await expect(client.requestClearance(request)).rejects.toThrow(VaultConnectionError);
    });

    it("should not retry on 400", async () => {
        const client = createRetryTestClient(2);
        let callCount = 0;

        server.use(
            http.post("https://vault.test/request-clearance", () => {
                callCount++;
                return new HttpResponse("Bad Request", { status: 400 });
            }),
        );

        const request: ClearanceRequest = {
            toolName: "stripe_refund",
            toolArgs: {},
            agentId: "test-agent",
            sessionId: "",
            context: {},
        };

        await expect(client.requestClearance(request)).rejects.toThrow(VaultConnectionError);
        expect(callCount).toBe(1);
    });
});

// ──────────────────────────────────────────────────────────────────────
// Client lifecycle
// ──────────────────────────────────────────────────────────────────────

describe("LedgixClient lifecycle", () => {
    it("should create with custom config", () => {
        const client = new LedgixClient({
            vaultUrl: "https://vault.test",
        });
        expect(client.config.vaultUrl).toBe("https://vault.test");
    });

    it("should create with default config", () => {
        const client = new LedgixClient();
        expect(client.config.vaultUrl).toBe("http://localhost:8000");
    });

    it("should close without error", async () => {
        const client = createTestClient();
        await expect(client.close()).resolves.toBeUndefined();
    });
});
