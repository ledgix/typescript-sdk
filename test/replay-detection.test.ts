// Ledgix ALCV — A-JWT jti replay detection tests

import { describe, expect, it, beforeEach } from "vitest";
import * as jose from "jose";

import { ReplayDetectedError, TokenVerificationError } from "../src/exceptions.js";
import { server, http, HttpResponse } from "./setup.js";
import { buildJwksResponse, createSampleJwt, createTestClient, generateTestKeys, type TestKeys } from "./helpers.js";

describe("A-JWT jti replay detection", () => {
    let keys: TestKeys;

    beforeEach(async () => {
        keys = await generateTestKeys();
        const jwks = await buildJwksResponse(keys.publicKey);
        server.use(
            http.get("https://vault.test/.well-known/jwks.json", () => HttpResponse.json(jwks)),
        );
    });

    it("raises ReplayDetectedError on second presentation of the same token", async () => {
        const client = createTestClient();
        const token = await createSampleJwt(keys.privateKey, { jti: "jti-replay-001" });

        // First call succeeds.
        await expect(client.verifyToken(token)).resolves.toBeDefined();

        // Second call with the same token raises.
        await expect(client.verifyToken(token)).rejects.toThrow(ReplayDetectedError);
    });

    it("carries the jti on ReplayDetectedError", async () => {
        const client = createTestClient();
        const token = await createSampleJwt(keys.privateKey, { jti: "jti-replay-002" });

        await client.verifyToken(token);

        try {
            await client.verifyToken(token);
            expect.fail("expected ReplayDetectedError");
        } catch (e) {
            expect(e).toBeInstanceOf(ReplayDetectedError);
            expect((e as ReplayDetectedError).jti).toBe("jti-replay-002");
        }
    });

    it("allows two different tokens with distinct jtis", async () => {
        const client = createTestClient();
        const tokenA = await createSampleJwt(keys.privateKey, { jti: "jti-distinct-a" });
        const tokenB = await createSampleJwt(keys.privateKey, { jti: "jti-distinct-b" });

        await expect(client.verifyToken(tokenA)).resolves.toBeDefined();
        await expect(client.verifyToken(tokenB)).resolves.toBeDefined();
    });

    it("raises TokenVerificationError when jti claim is missing", async () => {
        const client = createTestClient();

        // Mint a token that carries no jti claim.
        const tokenNoJti = await new jose.SignJWT({
            tool: "stripe_refund",
            request_id: "no-jti-req",
        })
            .setProtectedHeader({ alg: "EdDSA", kid: "test-key-001" })
            .setSubject("clearance")
            .setIssuer("alcv-vault")
            .setAudience("ledgix-sdk")
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(keys.privateKey);

        await expect(client.verifyToken(tokenNoJti)).rejects.toThrow(TokenVerificationError);

        try {
            await client.verifyToken(tokenNoJti);
        } catch (e) {
            expect((e as Error).message).toContain("jti");
        }
    });

    it("ReplayDetectedError is instanceof TokenVerificationError", () => {
        const err = new ReplayDetectedError("some-jti");
        expect(err).toBeInstanceOf(TokenVerificationError);
        expect(err).toBeInstanceOf(ReplayDetectedError);
        expect(err.name).toBe("ReplayDetectedError");
    });
});
