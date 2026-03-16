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
import type { LedgerEntry, LedgerManifest } from "../src/models.js";

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
    it("verifies signed ledger entries and manifests offline", async () => {
        const client = createTestClient();
        const keys = await generateTestKeys();
        const jwks = await buildJwksResponse(keys.publicKey);

        server.use(
            http.get("https://vault.test/.well-known/jwks.json", () => HttpResponse.json(jwks)),
        );

        const entryPayload = {
            client_id: "demo",
            seq: 1,
            request_id: "req-1",
            agent_id: "agent-1",
            policy_id: "policy-1",
            intent_hash: "intent-1",
            tool_name: "stripe_refund",
            tool_args: { amount: 45 },
            reason: "approved",
            citations: [],
            evidence_chunks: [],
            confidence: 0.91,
            decided_at: "2026-03-15T12:00:00Z",
            approved: true,
            prev_row_hash: "0000000000000000000000000000000000000000000000000000000000000000",
            row_hash: "rowhash-1",
        };
        const entryPayloadBytes = new TextEncoder().encode(JSON.stringify(entryPayload));
        const entrySignature = await crypto.subtle.sign("Ed25519", keys.privateKey, entryPayloadBytes);

        const manifestPayload = {
            client_id: "demo",
            period_start: "2026-03-15T12:00:00Z",
            period_end_exclusive: "2026-03-15T13:00:00Z",
            generated_at: "2026-03-15T12:05:00Z",
            head_seq: 1,
            head_row_hash: "rowhash-1",
            head_row_signature: encodeBase64Url(new Uint8Array(entrySignature)),
            prev_manifest_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            signer_key_id: "test-key-001",
        };
        const manifestPayloadBytes = new TextEncoder().encode(JSON.stringify(manifestPayload));
        const manifestHashBuffer = await crypto.subtle.digest("SHA-256", manifestPayloadBytes);
        const manifestSignature = await crypto.subtle.sign("Ed25519", keys.privateKey, manifestPayloadBytes);

        const entries: LedgerEntry[] = [
            {
                seq: 1,
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
                decidedAt: "2026-03-15T12:00:00Z",
                prevRowHash: "0000000000000000000000000000000000000000000000000000000000000000",
                rowHash: "rowhash-1",
                signatureAlgorithm: "Ed25519",
                signerKeyId: "test-key-001",
                rowSignature: encodeBase64Url(new Uint8Array(entrySignature)),
                receiptPayload: encodeBase64Url(entryPayloadBytes),
            },
        ];

        const manifests: LedgerManifest[] = [
            {
                periodStart: "2026-03-15T12:00:00Z",
                periodEndExclusive: "2026-03-15T13:00:00Z",
                generatedAt: "2026-03-15T12:05:00Z",
                headSeq: 1,
                headRowHash: "rowhash-1",
                headRowSignature: encodeBase64Url(new Uint8Array(entrySignature)),
                manifestHash: `sha256:${toHex(new Uint8Array(manifestHashBuffer))}`,
                prevManifestHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                signatureAlgorithm: "Ed25519",
                signerKeyId: "test-key-001",
                manifestSignature: encodeBase64Url(new Uint8Array(manifestSignature)),
                manifestPayload: encodeBase64Url(manifestPayloadBytes),
                anchorUri: "s3://ledger-anchors/demo/ledger-manifests/latest.json",
                anchoredAt: "2026-03-15T12:05:00Z",
            },
        ];

        const result = await client.verifyLedgerProof(entries, manifests);
        expect(result.intact).toBe(true);
        expect(result.verifiedEntries).toBe(1);
        expect(result.verifiedManifests).toBe(1);
        expect(result.latestRowHash).toBe("rowhash-1");
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
