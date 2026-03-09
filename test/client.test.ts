// Ledgix ALCV — Client Tests

import { describe, expect, it, beforeEach } from "vitest";

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
    createSampleJwt,
    createTestClient,
    deniedResponse,
    generateTestKeys,
    policyResponse,
    type TestKeys,
} from "./helpers.js";

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
