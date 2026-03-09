// Ledgix ALCV — Enforce Tests
// Tests for the higher-order function and callback context

import { describe, expect, it, beforeEach } from "vitest";

import { LedgixClient } from "../src/client.js";
import { vaultEnforce, withVaultContext } from "../src/enforce.js";
import { ClearanceDeniedError } from "../src/exceptions.js";
import type { ClearanceResponse } from "../src/models.js";
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
// vaultEnforce tests
// ──────────────────────────────────────────────────────────────────────

describe("vaultEnforce", () => {
    let client: LedgixClient;
    let keys: TestKeys;
    let sampleToken: string;

    beforeEach(async () => {
        client = createTestClient();
        keys = await generateTestKeys();
        sampleToken = await createSampleJwt(keys.privateKey);
    });

    it("should call the function when approved", async () => {
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const myTool = vaultEnforce(client, { toolName: "my_tool" })(
            async (x: number, y: number, _clearance?: ClearanceResponse) => {
                return x + y;
            },
        );

        const result = await myTool(3, 4);
        expect(result).toBe(7);
    });

    it("should throw ClearanceDeniedError when denied", async () => {
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json(deniedResponse());
            }),
        );

        const myTool = vaultEnforce(client, { toolName: "my_tool" })(
            async (x: number, _clearance?: ClearanceResponse) => {
                return x;
            },
        );

        await expect(myTool(42)).rejects.toThrow(ClearanceDeniedError);
    });

    it("should inject clearance as last argument", async () => {
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const myTool = vaultEnforce(client, { toolName: "my_tool" })(
            async (x: number, _clearance?: ClearanceResponse) => {
                return _clearance!.token;
            },
        );

        const result = await myTool(1);
        expect(result).not.toBeNull();
        expect(typeof result).toBe("string");
    });

    it("should use function name as default tool name", async () => {
        let capturedBody: Record<string, unknown> = {};

        server.use(
            http.post("https://vault.test/request-clearance", async ({ request }) => {
                capturedBody = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        async function stripe_refund(amount: number, _clearance?: ClearanceResponse) {
            return amount;
        }

        const guarded = vaultEnforce(client)(stripe_refund);
        await guarded(50.0);

        expect(capturedBody.tool_name).toBe("stripe_refund");
    });

    it("should extract tool args from function parameters", async () => {
        let capturedBody: Record<string, unknown> = {};

        server.use(
            http.post("https://vault.test/request-clearance", async ({ request }) => {
                capturedBody = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const processRefund = vaultEnforce(client, { toolName: "refund" })(
            async (amount: number, reason: string, _clearance?: ClearanceResponse) => {
                return "done";
            },
        );

        await processRefund(99.99, "late delivery");

        const toolArgs = capturedBody.tool_args as Record<string, unknown>;
        expect(toolArgs.amount).toBe(99.99);
        expect(toolArgs.reason).toBe("late delivery");
    });

    it("should include policy_id in context", async () => {
        let capturedBody: Record<string, unknown> = {};

        server.use(
            http.post("https://vault.test/request-clearance", async ({ request }) => {
                capturedBody = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const processRefund = vaultEnforce(client, {
            toolName: "refund",
            policyId: "refund-policy",
        })(async (amount: number, _clearance?: ClearanceResponse) => {
            return "done";
        });

        await processRefund(50.0);

        const context = capturedBody.context as Record<string, unknown>;
        expect(context.policy_id).toBe("refund-policy");
    });
});

// ──────────────────────────────────────────────────────────────────────
// withVaultContext tests
// ──────────────────────────────────────────────────────────────────────

describe("withVaultContext", () => {
    let client: LedgixClient;
    let keys: TestKeys;
    let sampleToken: string;

    beforeEach(async () => {
        client = createTestClient();
        keys = await generateTestKeys();
        sampleToken = await createSampleJwt(keys.privateKey);
    });

    it("should provide clearance when approved", async () => {
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const result = await withVaultContext(
            client,
            "refund_tool",
            { amount: 45 },
            {},
            async (clearance) => {
                expect(clearance.approved).toBe(true);
                expect(clearance.token).not.toBeNull();
                return "success";
            },
        );

        expect(result).toBe("success");
    });

    it("should throw ClearanceDeniedError when denied", async () => {
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return HttpResponse.json(deniedResponse());
            }),
        );

        await expect(
            withVaultContext(
                client,
                "refund_tool",
                { amount: 5000 },
                {},
                async () => {
                    throw new Error("Should not reach here");
                },
            ),
        ).rejects.toThrow(ClearanceDeniedError);
    });

    it("should include policy_id in context", async () => {
        let capturedBody: Record<string, unknown> = {};

        server.use(
            http.post("https://vault.test/request-clearance", async ({ request }) => {
                capturedBody = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        await withVaultContext(
            client,
            "refund_tool",
            { amount: 45 },
            { policyId: "refund-policy" },
            async () => "done",
        );

        const context = capturedBody.context as Record<string, unknown>;
        expect(context.policy_id).toBe("refund-policy");
    });
});
