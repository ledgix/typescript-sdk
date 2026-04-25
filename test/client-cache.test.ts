// Tests for the SDK-side decision cache (Milestone B3c).

import { describe, expect, it, beforeEach } from "vitest";
import * as jose from "jose";

import { LedgixClient } from "../src/client.js";
import { VaultConnectionError } from "../src/exceptions.js";
import type { ClearanceRequest } from "../src/models.js";
import { server, http, HttpResponse } from "./setup.js";
import { createSampleJwt, generateTestKeys, type TestKeys } from "./helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cacheClient(overrides: Record<string, unknown> = {}): LedgixClient {
    return new LedgixClient({
        vaultUrl: "https://vault.test",
        vaultApiKey: "test-key",
        vaultTimeout: 5000,
        verifyJwt: false,
        maxRetries: 0,
        agentId: "agent-1",
        sessionId: "sess-1",
        decisionCacheEnabled: true,
        decisionCacheTtlMs: 60_000,
        decisionCacheMaxEntries: 100,
        ...overrides,
    });
}

function approvedBody(token: string, policyVersionId = "pvid-001") {
    return {
        status: "approved",
        approved: true,
        token,
        reason: "Policy passed",
        request_id: "req-original-001",
        confidence: 0.95,
        minimum_confidence_score: 0.5,
        policy_version_id: policyVersionId,
        policy_content_hash: "sha256:abc",
    };
}

function mintBody(token: string, requestId = "req-mint-001") {
    return {
        request_id: requestId,
        token,
        approved: true,
        reason: "Policy passed",
    };
}

const baseRequest: ClearanceRequest = {
    toolName: "stripe_refund",
    toolArgs: { amount: 50 },
    agentId: "agent-1",
    sessionId: "sess-1",
    context: {},
};

// ---------------------------------------------------------------------------
// Cache key tests
// ---------------------------------------------------------------------------

describe("LedgixClient decision cache key", () => {
    it("is stable across repeated calls", () => {
        const client = cacheClient();
        const k1 = (client as unknown as { _buildCacheKey(r: ClearanceRequest): string })._buildCacheKey(baseRequest);
        const k2 = (client as unknown as { _buildCacheKey(r: ClearanceRequest): string })._buildCacheKey(baseRequest);
        expect(k1).toBe(k2);
        expect(k1).not.toBe("");
    });

    it("differs by toolName", () => {
        const client = cacheClient();
        const _buildCacheKey = (r: ClearanceRequest) =>
            (client as unknown as { _buildCacheKey(r: ClearanceRequest): string })._buildCacheKey(r);
        const k1 = _buildCacheKey({ ...baseRequest, toolName: "stripe_refund" });
        const k2 = _buildCacheKey({ ...baseRequest, toolName: "send_email" });
        expect(k1).not.toBe(k2);
    });

    it("is invariant to toolArgs key order", () => {
        const client = cacheClient();
        const _buildCacheKey = (r: ClearanceRequest) =>
            (client as unknown as { _buildCacheKey(r: ClearanceRequest): string })._buildCacheKey(r);
        const k1 = _buildCacheKey({ ...baseRequest, toolArgs: { b: 2, a: 1 } });
        const k2 = _buildCacheKey({ ...baseRequest, toolArgs: { a: 1, b: 2 } });
        expect(k1).toBe(k2);
    });

    it("differs by agentId", () => {
        const client = cacheClient();
        const _buildCacheKey = (r: ClearanceRequest) =>
            (client as unknown as { _buildCacheKey(r: ClearanceRequest): string })._buildCacheKey(r);
        const k1 = _buildCacheKey({ ...baseRequest, agentId: "agent-A" });
        const k2 = _buildCacheKey({ ...baseRequest, agentId: "agent-B" });
        expect(k1).not.toBe(k2);
    });

    it("returns empty string for oversized toolArgs", () => {
        const client = cacheClient();
        const _buildCacheKey = (r: ClearanceRequest) =>
            (client as unknown as { _buildCacheKey(r: ClearanceRequest): string })._buildCacheKey(r);
        const big = { data: "x".repeat(70_000) };
        expect(_buildCacheKey({ ...baseRequest, toolArgs: big })).toBe("");
    });
});

// ---------------------------------------------------------------------------
// Sync cache hit / miss
// ---------------------------------------------------------------------------

describe("LedgixClient decision cache — hit/miss", () => {
    let keys: TestKeys;
    let token: string;
    let mintToken: string;

    beforeEach(async () => {
        keys = await generateTestKeys();
        token = await createSampleJwt(keys.privateKey);
        mintToken = await createSampleJwt(keys.privateKey);
    });

    it("first call is a miss (uses /request-clearance), second is a hit (uses /mint-token)", async () => {
        const client = cacheClient();
        let clearanceCount = 0;
        let mintCount = 0;

        server.use(
            http.post("https://vault.test/request-clearance", () => {
                clearanceCount++;
                return HttpResponse.json(approvedBody(token));
            }),
            http.post("https://vault.test/mint-token", () => {
                mintCount++;
                return HttpResponse.json(mintBody(mintToken));
            }),
        );

        const r1 = await client.requestClearance(baseRequest);
        expect(r1.approved).toBe(true);
        expect(clearanceCount).toBe(1);
        expect(mintCount).toBe(0);

        const r2 = await client.requestClearance(baseRequest);
        expect(r2.approved).toBe(true);
        expect(clearanceCount).toBe(1);
        expect(mintCount).toBe(1);
    });

    it("does not cache denied responses", async () => {
        const client = cacheClient();

        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json({
                    status: "denied",
                    approved: false,
                    token: null,
                    reason: "Denied",
                    request_id: "req-deny",
                    confidence: 0.9,
                    minimum_confidence_score: 0.5,
                });
            }),
        );

        await expect(client.requestClearance(baseRequest)).rejects.toThrow();
        const key = (client as unknown as { _buildCacheKey(r: ClearanceRequest): string })._buildCacheKey(baseRequest);
        const cached = (client as unknown as { _cacheGet(k: string): unknown })._cacheGet(key);
        expect(cached).toBeNull();
    });

    it("does not cache when policy_version_id is missing", async () => {
        const client = cacheClient();

        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json({
                    status: "approved",
                    approved: true,
                    token,
                    reason: "ok",
                    request_id: "req-001",
                    confidence: 0.9,
                    minimum_confidence_score: 0.5,
                    policy_version_id: null,
                });
            }),
        );

        await client.requestClearance(baseRequest);
        const key = (client as unknown as { _buildCacheKey(r: ClearanceRequest): string })._buildCacheKey(baseRequest);
        const cached = (client as unknown as { _cacheGet(k: string): unknown })._cacheGet(key);
        expect(cached).toBeNull();
    });

    it("clearCache() flushes entries so next call is a miss", async () => {
        const client = cacheClient();
        let clearanceCount = 0;

        server.use(
            http.post("https://vault.test/request-clearance", () => {
                clearanceCount++;
                return HttpResponse.json(approvedBody(token));
            }),
            http.post("https://vault.test/mint-token", () => {
                return HttpResponse.json(mintBody(mintToken));
            }),
        );

        await client.requestClearance(baseRequest);
        expect(clearanceCount).toBe(1);

        client.clearCache();

        await client.requestClearance(baseRequest);
        expect(clearanceCount).toBe(2); // cache miss after clear
    });

    it("cache is isolated by agentId", async () => {
        const client = cacheClient();
        let clearanceCount = 0;

        server.use(
            http.post("https://vault.test/request-clearance", () => {
                clearanceCount++;
                return HttpResponse.json(approvedBody(token));
            }),
        );

        const reqA = { ...baseRequest, agentId: "agent-A" };
        const reqB = { ...baseRequest, agentId: "agent-B" };

        await client.requestClearance(reqA);
        await client.requestClearance(reqB);
        expect(clearanceCount).toBe(2); // different keys — both misses
    });

    it("cache is disabled by default (no decisionCacheEnabled)", async () => {
        const client = new LedgixClient({
            vaultUrl: "https://vault.test",
            vaultApiKey: "test-key",
            vaultTimeout: 5000,
            verifyJwt: false,
            maxRetries: 0,
            // decisionCacheEnabled defaults to false
        });

        expect((client as unknown as { _decisionCache: unknown })._decisionCache).toBeNull();

        let clearanceCount = 0;
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                clearanceCount++;
                return HttpResponse.json(approvedBody(token));
            }),
        );

        await client.requestClearance(baseRequest);
        await client.requestClearance(baseRequest);
        expect(clearanceCount).toBe(2); // no caching
    });

    it("throws VaultConnectionError when /mint-token fails", async () => {
        const client = cacheClient();

        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json(approvedBody(token));
            }),
            http.post("https://vault.test/mint-token", () => {
                return HttpResponse.json({ error: "oops" }, { status: 500 });
            }),
        );

        await client.requestClearance(baseRequest);

        await expect(client.requestClearance(baseRequest)).rejects.toThrow(VaultConnectionError);
    });

    it("mint response carries fresh requestId and policyVersionId", async () => {
        const client = cacheClient();

        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json(approvedBody(token));
            }),
            http.post("https://vault.test/mint-token", () => {
                return HttpResponse.json(mintBody(mintToken, "req-fresh-999"));
            }),
        );

        await client.requestClearance(baseRequest);
        const r2 = await client.requestClearance(baseRequest);

        expect(r2.requestId).toBe("req-fresh-999");
        expect(r2.policyVersionId).toBe("pvid-001");
        expect(r2.token).toBe(mintToken);
    });
});
