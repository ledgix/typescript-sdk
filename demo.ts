#!/usr/bin/env npx tsx
/**
 * Ledgix ALCV SDK — Demo Script
 *
 * Simulates the "Good Agent" vs "Rogue Agent" scenario from the
 * ALCV Vault technical specification.
 *
 * This demo runs without a real Vault server by using a lightweight mock.
 *
 * Usage:
 *   npx tsx demo.ts
 */

import * as jose from "jose";

// ──────────────────────────────────────────────────────────────────────
// Mock Vault (only used when no live Vault is configured)
// ──────────────────────────────────────────────────────────────────────

// Generate a demo Ed25519 key pair for A-JWT signing
const { publicKey: DEMO_PUBLIC_KEY, privateKey: DEMO_PRIVATE_KEY } =
    await jose.generateKeyPair("EdDSA", { crv: "Ed25519" });

const REFUND_POLICY = {
    policy_id: "refund-policy-001",
    description: "Customer refund policy for shipping delays",
    rules: [
        "Refunds are allowed up to $100 for shipping delays",
        "Refund recipient must be the original customer",
        "Agent must provide a valid order ID",
    ],
};

async function mockClearanceDecision(
    toolName: string,
    toolArgs: Record<string, unknown>,
): Promise<{
    approved: boolean;
    token: string | null;
    reason: string;
    request_id: string;
}> {
    const amount = (toolArgs.amount as number) ?? 0;
    const recipient = (toolArgs.recipient as string) ?? "customer";

    const approved = amount <= 100 && recipient !== "agent_personal_account";

    if (approved) {
        const requestId = `demo-${Date.now()}`;
        const token = await new jose.SignJWT({
            sub: "clearance",
            tool: toolName,
            amount,
            request_id: requestId,
        })
            .setProtectedHeader({ alg: "EdDSA" })
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(DEMO_PRIVATE_KEY);

        return {
            approved: true,
            token,
            reason: "Policy check passed — refund within limits",
            request_id: requestId,
        };
    } else {
        const reasons: string[] = [];
        if (amount > 100) reasons.push(`Amount $${amount} exceeds $100 limit`);
        if (recipient === "agent_personal_account")
            reasons.push("Recipient is not the original customer");

        return {
            approved: false,
            token: null,
            reason: reasons.join("; "),
            request_id: `demo-${Date.now()}`,
        };
    }
}

// ──────────────────────────────────────────────────────────────────────
// Simulated Stripe Tool
// ──────────────────────────────────────────────────────────────────────

function stripeRefund(
    amount: number,
    reason: string,
    orderId: string,
    token: string | null,
): string {
    const tokenPreview = token ? token.slice(0, 40) + "..." : "N/A";
    return [
        "✅ REFUND PROCESSED",
        `   Amount:  $${amount.toFixed(2)}`,
        `   Reason:  ${reason}`,
        `   Order:   ${orderId}`,
        `   A-JWT:   ${tokenPreview}`,
    ].join("\n");
}

// ──────────────────────────────────────────────────────────────────────
// Demo Runner
// ──────────────────────────────────────────────────────────────────────

async function runDemo(): Promise<void> {
    console.log("=".repeat(64));
    console.log("  LEDGIX ALCV — SDK Demo (TypeScript)");
    console.log('  Policy: "Refunds ≤ $100 for shipping delays only"');
    console.log("=".repeat(64));

    // ── Scenario A: Good Agent ─────────────────────────────────────
    console.log("\n" + "─".repeat(64));
    console.log("  SCENARIO A: Good Agent");
    console.log("  Agent requests $45 refund for a late package");
    console.log("─".repeat(64) + "\n");

    const toolArgsGood = {
        amount: 45.0,
        reason: "Package arrived 5 days late",
        order_id: "ORD-2026-1234",
        recipient: "customer",
    };

    const decisionA = await mockClearanceDecision("stripe_refund", toolArgsGood);
    console.log(
        `  Vault decision: ${decisionA.approved ? "✅ APPROVED" : "❌ DENIED"}`,
    );
    console.log(`  Reason: ${decisionA.reason}`);

    if (decisionA.approved) {
        const result = stripeRefund(
            toolArgsGood.amount,
            toolArgsGood.reason,
            toolArgsGood.order_id,
            decisionA.token,
        );
        console.log(`\n${result}`);
    }

    // ── Scenario B: Rogue Agent ────────────────────────────────────
    console.log("\n" + "─".repeat(64));
    console.log("  SCENARIO B: Rogue Agent");
    console.log("  Agent (prompt-injected) tries $5,000 refund to own account");
    console.log("─".repeat(64) + "\n");

    const toolArgsRogue = {
        amount: 5000.0,
        reason: "Customer requested full refund",
        order_id: "ORD-2026-9999",
        recipient: "agent_personal_account",
    };

    const decisionB = await mockClearanceDecision("stripe_refund", toolArgsRogue);
    console.log(
        `  Vault decision: ${decisionB.approved ? "✅ APPROVED" : "❌ DENIED"}`,
    );
    console.log(`  Reason: ${decisionB.reason}`);

    if (!decisionB.approved) {
        console.log("\n  🛡️  Tool call BLOCKED — no A-JWT issued");
        console.log(
            "  The Stripe tool would refuse execution without a valid token.",
        );
    }

    // ── Summary ────────────────────────────────────────────────────
    console.log("\n" + "=".repeat(64));
    console.log("  Demo complete!");
    console.log("  The ALCV Vault SDK intercepted both tool calls.");
    console.log("  • Good agent: Approved and received a signed A-JWT");
    console.log("  • Rogue agent: Denied — policy violation detected");
    console.log("=".repeat(64));
}

runDemo().catch(console.error);
