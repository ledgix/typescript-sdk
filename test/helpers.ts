// Ledgix ALCV — Test Helpers
// Shared fixtures for the test suite (Ed25519 keys, JWTs, configs)

import * as jose from "jose";

import { LedgixClient } from "../src/client.js";
import type { VaultConfig } from "../src/config.js";

// ──────────────────────────────────────────────────────────────────────
// Crypto helpers
// ──────────────────────────────────────────────────────────────────────

export interface TestKeys {
    privateKey: Awaited<ReturnType<typeof jose.generateKeyPair>>["privateKey"];
    publicKey: Awaited<ReturnType<typeof jose.generateKeyPair>>["publicKey"];
}

export async function generateTestKeys(): Promise<TestKeys> {
    const { publicKey, privateKey } = await jose.generateKeyPair("EdDSA", {
        crv: "Ed25519",
    });
    return { privateKey, publicKey };
}

export async function createSampleJwt(
    privateKey: Awaited<ReturnType<typeof jose.generateKeyPair>>["privateKey"],
): Promise<string> {
    return new jose.SignJWT({
        tool: "stripe_refund",
        amount: 45.0,
        request_id: "test-req-001",
    })
        .setProtectedHeader({ alg: "EdDSA" })
        .setSubject("clearance")
        .setIssuer("alcv-vault")
        .setAudience("ledgix-sdk")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
}

export async function createExpiredJwt(
    privateKey: Awaited<ReturnType<typeof jose.generateKeyPair>>["privateKey"],
): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new jose.SignJWT({
        tool: "stripe_refund",
        request_id: "test-req-expired",
    })
        .setProtectedHeader({ alg: "EdDSA" })
        .setSubject("clearance")
        .setIssuer("alcv-vault")
        .setAudience("ledgix-sdk")
        .setIssuedAt(now - 3600)
        .setExpirationTime(now - 300)
        .sign(privateKey);
}

export async function buildJwksResponse(
    publicKey: Awaited<ReturnType<typeof jose.generateKeyPair>>["publicKey"],
): Promise<{ keys: jose.JWK[] }> {
    const jwk = await jose.exportJWK(publicKey);
    jwk.use = "sig";
    jwk.kid = "test-key-001";
    return { keys: [jwk] };
}

// ──────────────────────────────────────────────────────────────────────
// Config + Client helpers
// ──────────────────────────────────────────────────────────────────────

export const testVaultConfig: Partial<VaultConfig> = {
    vaultUrl: "https://vault.test",
    vaultApiKey: "test-api-key",
    vaultTimeout: 5000,
    verifyJwt: false,
    jwtIssuer: "alcv-vault",
    jwtAudience: "ledgix-sdk",
    agentId: "test-agent",
    sessionId: "test-session",
    maxRetries: 0,
};

export const testVaultConfigWithJwt: Partial<VaultConfig> = {
    ...testVaultConfig,
    verifyJwt: true,
};

export function createTestClient(overrides?: Partial<VaultConfig>): LedgixClient {
    return new LedgixClient({ ...testVaultConfig, ...overrides });
}

/** Client with retries enabled and zero backoff for fast retry tests. */
export function createRetryTestClient(maxRetries = 2): LedgixClient {
    return new LedgixClient({ ...testVaultConfig, maxRetries, retryBaseDelay: 0 });
}

// ──────────────────────────────────────────────────────────────────────
// Vault API mock responses
// ──────────────────────────────────────────────────────────────────────

export function approvedResponse(token: string) {
    return {
        status: "approved",
        approved: true,
        token,
        reason: "Policy check passed",
        request_id: "req-001",
    };
}

export function deniedResponse() {
    return {
        status: "denied",
        approved: false,
        token: null,
        reason: "Amount exceeds $100 limit",
        request_id: "req-002",
    };
}

export function policyResponse() {
    return {
        policy_id: "refund-policy",
        status: "registered",
        message: "Policy registered successfully",
    };
}
