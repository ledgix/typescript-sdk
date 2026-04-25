// Ledgix ALCV — JWKS kid matching + rotation tests

import { describe, expect, it, beforeEach } from "vitest";
import * as jose from "jose";

import { TokenVerificationError } from "../src/exceptions.js";
import { server, http, HttpResponse } from "./setup.js";
import { buildJwksResponse, createSampleJwt, createTestClient, generateTestKeys, type TestKeys } from "./helpers.js";

describe("JWKS kid matching and rotation", () => {
    let keysK1: TestKeys;
    let keysK2: TestKeys;

    beforeEach(async () => {
        keysK1 = await generateTestKeys();
        keysK2 = await generateTestKeys();
    });

    it("verifies a token whose kid matches the JWKS key", async () => {
        const client = createTestClient();
        const jwks = await buildJwksResponse(keysK1.publicKey, "k1");
        const token = await createSampleJwt(keysK1.privateKey, { kid: "k1", jti: "jti-kid-match" });

        server.use(
            http.get("https://vault.test/.well-known/jwks.json", () => HttpResponse.json(jwks)),
        );

        const payload = await client.verifyToken(token);
        expect(payload.sub).toBe("clearance");
    });

    it("refetches JWKS on kid miss and succeeds after rotation", async () => {
        const client = createTestClient();

        // JWKS v1: only k1
        const jwksV1 = await buildJwksResponse(keysK1.publicKey, "k1");
        // JWKS v2: only k2
        const jwksV2 = await buildJwksResponse(keysK2.publicKey, "k2");

        // Prime the client cache with k1.
        server.use(
            http.get("https://vault.test/.well-known/jwks.json", () => HttpResponse.json(jwksV1)),
        );
        await client.fetchJwks();

        // Switch server to v2 (k2 only). Token is signed with k2.
        server.use(
            http.get("https://vault.test/.well-known/jwks.json", () => HttpResponse.json(jwksV2)),
        );
        const tokenK2 = await createSampleJwt(keysK2.privateKey, { kid: "k2", jti: "jti-rotation" });

        // Client should detect kid miss → refetch → find k2 → succeed.
        const payload = await client.verifyToken(tokenK2);
        expect(payload.sub).toBe("clearance");
    });

    it("throws TokenVerificationError when kid is absent from JWKS even after refetch", async () => {
        const client = createTestClient();

        // JWKS always returns only k1; token is signed with unknown key k3.
        const jwks = await buildJwksResponse(keysK1.publicKey, "k1");
        server.use(
            http.get("https://vault.test/.well-known/jwks.json", () => HttpResponse.json(jwks)),
        );

        // Generate k3 locally — Vault never publishes it.
        const keysK3 = await generateTestKeys();
        const tokenK3 = await createSampleJwt(keysK3.privateKey, { kid: "k3", jti: "jti-unknown-kid" });

        await expect(client.verifyToken(tokenK3)).rejects.toThrow(TokenVerificationError);

        try {
            await client.verifyToken(tokenK3);
        } catch (e) {
            expect((e as Error).message).toContain("k3");
        }
    });

    it("does not refetch when the kid is already cached", async () => {
        const client = createTestClient();
        const jwks = await buildJwksResponse(keysK1.publicKey, "k1");

        let fetchCount = 0;
        server.use(
            http.get("https://vault.test/.well-known/jwks.json", () => {
                fetchCount++;
                return HttpResponse.json(jwks);
            }),
        );

        const token1 = await createSampleJwt(keysK1.privateKey, { kid: "k1", jti: "jti-cached-1" });
        const token2 = await createSampleJwt(keysK1.privateKey, { kid: "k1", jti: "jti-cached-2" });

        await client.verifyToken(token1);
        await client.verifyToken(token2);

        // Exactly one JWKS fetch: the second token hit the cache.
        expect(fetchCount).toBe(1);
    });
});
