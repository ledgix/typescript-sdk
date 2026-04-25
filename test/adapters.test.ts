// Ledgix ALCV — Adapter Tests
// Tests for LangChain, LlamaIndex, and Vercel AI adapters

import { describe, expect, it, beforeEach } from "vitest";

import { LedgixClient } from "../src/client.js";
import { ClearanceDeniedError } from "../src/exceptions.js";
import { server, http, HttpResponse } from "./setup.js";
import {
    approvedResponse,
    createSampleJwt,
    createTestClient,
    deniedResponse,
    generateTestKeys,
    type TestKeys,
} from "./helpers.js";

// ──────────────────────────────────────────────────────────────────────
// LangChain adapter tests
// ──────────────────────────────────────────────────────────────────────

describe("LangChain adapter", () => {
    let client: LedgixClient;
    let keys: TestKeys;
    let sampleToken: string;

    beforeEach(async () => {
        client = createTestClient();
        keys = await generateTestKeys();
        sampleToken = await createSampleJwt(keys.privateKey);
    });

    it("should wrap a tool function with clearance (approved)", async () => {
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const { wrapLangChainTool } = await import("../src/adapters/langchain.js");

        const originalFn = async (args: Record<string, unknown>) => `result for ${args.query}`;

        const guarded = wrapLangChainTool(client, "search", originalFn, {
            policyId: "search-policy",
        });

        const result = await guarded({ query: "test" });
        expect(result).toBe("result for test");
    });

    it("should throw ClearanceDeniedError when denied", async () => {
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json(deniedResponse());
            }),
        );

        const { wrapLangChainTool } = await import("../src/adapters/langchain.js");

        const originalFn = async (args: Record<string, unknown>) => `result`;
        const guarded = wrapLangChainTool(client, "search", originalFn);

        await expect(guarded({ query: "test" })).rejects.toThrow(ClearanceDeniedError);
    });

    it("should send correct tool name and args", async () => {
        let capturedBody: Record<string, unknown> = {};

        server.use(
            http.post("https://vault.test/request-clearance", async ({ request }) => {
                capturedBody = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const { wrapLangChainTool } = await import("../src/adapters/langchain.js");

        const originalFn = async (args: Record<string, unknown>) => "done";
        const guarded = wrapLangChainTool(client, "stripe_refund", originalFn, {
            policyId: "refund-policy",
        });

        await guarded({ amount: 45 });

        expect(capturedBody.tool_name).toBe("stripe_refund");
        const context = capturedBody.context as Record<string, unknown>;
        expect(context.policy_id).toBe("refund-policy");
    });
});

// ──────────────────────────────────────────────────────────────────────
// LlamaIndex adapter tests
// ──────────────────────────────────────────────────────────────────────

describe("LlamaIndex adapter", () => {
    let client: LedgixClient;
    let keys: TestKeys;
    let sampleToken: string;

    beforeEach(async () => {
        client = createTestClient();
        keys = await generateTestKeys();
        sampleToken = await createSampleJwt(keys.privateKey);
    });

    it("should wrap a tool function (approved)", async () => {
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const { wrapTool } = await import("../src/adapters/llamaindex.js");

        const mySearch = async (args: Record<string, unknown>) =>
            `results for ${args.query}`;

        const guarded = wrapTool(client, "search", mySearch, {
            policyId: "search-policy",
        });

        const result = await guarded({ query: "test" });
        expect(result).toBe("results for test");
    });

    it("should throw ClearanceDeniedError when denied", async () => {
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json(deniedResponse());
            }),
        );

        const { wrapTool } = await import("../src/adapters/llamaindex.js");

        const mySearch = async (args: Record<string, unknown>) => "should not reach";
        const guarded = wrapTool(client, "search", mySearch);

        await expect(guarded({ query: "test" })).rejects.toThrow(ClearanceDeniedError);
    });
});

// ──────────────────────────────────────────────────────────────────────
// Vercel AI adapter tests
// ──────────────────────────────────────────────────────────────────────

describe("Vercel AI adapter", () => {
    let client: LedgixClient;
    let keys: TestKeys;
    let sampleToken: string;

    beforeEach(async () => {
        client = createTestClient();
        keys = await generateTestKeys();
        sampleToken = await createSampleJwt(keys.privateKey);
    });

    it("should wrap a tool execute function (approved)", async () => {
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const { wrapVercelTool } = await import("../src/adapters/vercel-ai.js");

        const execute = async (args: { amount: number; reason: string }) => ({
            refunded: args.amount,
            reason: args.reason,
        });

        const guarded = wrapVercelTool(client, "stripe_refund", execute, {
            policyId: "refund-policy",
        });

        const result = await guarded({ amount: 45, reason: "late" });
        expect(result.refunded).toBe(45);
        expect(result.reason).toBe("late");
    });

    it("should throw ClearanceDeniedError when denied", async () => {
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json(deniedResponse());
            }),
        );

        const { wrapVercelTool } = await import("../src/adapters/vercel-ai.js");

        const execute = async (args: { amount: number }) => ({ refunded: args.amount });
        const guarded = wrapVercelTool(client, "stripe_refund", execute);

        await expect(guarded({ amount: 5000 })).rejects.toThrow(ClearanceDeniedError);
    });

    it("should include policy_id and context in clearance request", async () => {
        let capturedBody: Record<string, unknown> = {};

        server.use(
            http.post("https://vault.test/request-clearance", async ({ request }) => {
                capturedBody = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const { wrapVercelTool } = await import("../src/adapters/vercel-ai.js");

        const execute = async (args: { amount: number }) => ({ ok: true });
        const guarded = wrapVercelTool(client, "refund", execute, {
            policyId: "policy-1",
            context: { source: "vercel-ai" },
        });

        await guarded({ amount: 50 });

        const context = capturedBody.context as Record<string, unknown>;
        expect(context.policy_id).toBe("policy-1");
        expect(context.source).toBe("vercel-ai");
    });
});
