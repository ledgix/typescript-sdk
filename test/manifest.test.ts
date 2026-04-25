import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configure, autoInstrument, currentToken, tool } from "../src/enforce.js";
import { loadManifest, _globMatch } from "../src/manifest.js";
import { server, http, HttpResponse } from "./setup.js";
import { approvedResponse, createSampleJwt, createTestClient, generateTestKeys } from "./helpers.js";

describe("manifest helpers", () => {
    const previousCwd = process.cwd();
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "ledgix-ts-manifest-"));
    });

    afterEach(() => {
        process.chdir(previousCwd);
        rmSync(tempDir, { recursive: true, force: true });
    });

    it("loads inline manifest objects", () => {
        const manifest = loadManifest({
            enforce: [{ tool: "stripe*", policyId: "financial-high-risk" }],
        });

        expect(manifest.match("stripeCharge")?.policyId).toBe("financial-high-risk");
    });

    it("discovers ledgix.json from the working directory", () => {
        writeFileSync(
            join(tempDir, "ledgix.json"),
            JSON.stringify({
                enforce: [{ tool: "dbWrite*", policyId: "data-mutation" }],
            }),
            "utf-8",
        );
        process.chdir(tempDir);

        const manifest = loadManifest();

        expect(manifest.source.endsWith("/ledgix.json")).toBe(true);
        expect(manifest.match("dbWriteInvoice")?.policyId).toBe("data-mutation");
    });

    it("raises a helpful error when no default manifest exists", () => {
        process.chdir(tempDir);

        expect(() => loadManifest()).toThrow(/No Ledgix manifest found/i);
    });

    it("supports first-match-wins glob rules", () => {
        const manifest = loadManifest({
            enforce: [
                { tool: "stripe*", policyId: "first" },
                { tool: "*", policyId: "fallback" },
            ],
        });

        expect(manifest.match("stripeRefund")?.policyId).toBe("first");
        expect(manifest.match("otherTool")?.policyId).toBe("fallback");
        expect(_globMatch("dbWrite?", "dbWrite1")).toBe(true);
        expect(_globMatch("dbWrite?", "dbWriteExtra")).toBe(false);
    });
});

describe("autoInstrument", () => {
    it("wraps matching functions and preserves unmatched entries", async () => {
        const keys = await generateTestKeys();
        const sampleToken = await createSampleJwt(keys.privateKey);
        let capturedBody: Record<string, unknown> = {};

        configure(createTestClient());
        server.use(
            http.post("https://vault.test/request-clearance", async ({ request }) => {
                capturedBody = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const rawTools = {
            stripeCharge: async (amount: number) => ({ amount, token: currentToken() }),
            readOnlyLookup: async (id: string) => ({ id, token: currentToken() }),
            version: "1.0.0",
        };

        const tools = autoInstrument(rawTools, {
            enforce: [{ tool: "stripe*", policyId: "financial-high-risk" }],
        });

        const result = await tools.stripeCharge(42);
        const untouched = await tools.readOnlyLookup("abc");

        expect(result.token).toBe(sampleToken);
        expect(untouched.token).toBeUndefined();
        expect(tools.version).toBe("1.0.0");
        expect((capturedBody.context as Record<string, unknown>).policy_id).toBe("financial-high-risk");
    });
});

describe("tool escape hatch", () => {
    it("uses the loaded manifest rule when present", async () => {
        const keys = await generateTestKeys();
        const sampleToken = await createSampleJwt(keys.privateKey);
        let capturedBody: Record<string, unknown> = {};

        configure(createTestClient());
        autoInstrument({}, {
            enforce: [{ tool: "special*", policyId: "manifest-policy", context: { risk_level: "high" } }],
        });
        server.use(
            http.post("https://vault.test/request-clearance", async ({ request }) => {
                capturedBody = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const specialFn = tool(async function specialRefund() {
            return currentToken();
        });

        await expect(specialFn()).resolves.toBe(sampleToken);
        expect(capturedBody.context).toEqual({
            risk_level: "high",
            policy_id: "manifest-policy",
        });
    });

    it("prefers explicit overrides over manifest values", async () => {
        const keys = await generateTestKeys();
        const sampleToken = await createSampleJwt(keys.privateKey);
        let capturedBody: Record<string, unknown> = {};

        configure(createTestClient());
        autoInstrument({}, {
            enforce: [{ tool: "special*", policyId: "manifest-policy", context: { source: "manifest" } }],
        });
        server.use(
            http.post("https://vault.test/request-clearance", async ({ request }) => {
                capturedBody = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json(approvedResponse(sampleToken));
            }),
        );

        const specialFn = tool(
            async function specialCharge() {
                return currentToken();
            },
            { policyId: "override-policy", context: { source: "override" } },
        );

        await expect(specialFn()).resolves.toBe(sampleToken);
        expect(capturedBody.context).toEqual({
            source: "override",
            policy_id: "override-policy",
        });
    });
});
