// Client-side counterparty extractor tests.
//
// Mirrors the server-side chain in vault/internal/counterparty so the SDK
// populates the same provider keys and account refs the Vault would derive
// on its own (caller-supplied wins on both sides).

import { describe, expect, it } from "vitest";

import { extractCounterparty } from "../src/counterparty.js";

describe("extractCounterparty", () => {
    it("truncates Stripe API key for account ref", () => {
        const out = extractCounterparty("stripe.create_charge", {
            // ship-safe-ignore Generic API Key Assignment — dummy test fixture, not a real credential
            api_key: "sk_test_abcdefghij1234",
            amount: 500,
        });
        expect(out.destinationProvider).toBe("stripe");
        expect(out.destinationUri).toBe("https://api.stripe.com");
        expect(out.destinationAccountRef).toBe("sk_test_abcd");
    });

    it("uses bedrock model_id as account ref", () => {
        const out = extractCounterparty("aws.bedrock_invoke", {
            model_id: "anthropic.claude-sonnet-4-5-v1:0",
        });
        expect(out.destinationProvider).toBe("aws-bedrock");
        expect(out.destinationAccountRef).toBe("anthropic.claude-sonnet-4-5-v1:0");
    });

    it("falls back to URL host for unknown providers", () => {
        const out = extractCounterparty("internal.web_request", {
            url: "https://api.notion.com/v1/pages",
        });
        expect(out.destinationUri).toBe("https://api.notion.com/v1/pages");
        expect(out.destinationProvider).toBe("notion.com");
    });

    it("returns empty for unknown tool with no URL hint", () => {
        expect(extractCounterparty("internal.compute_thing", { x: 1 })).toEqual({});
    });

    it("returns empty for empty tool name", () => {
        expect(extractCounterparty("", { url: "https://api.openai.com" })).toEqual({});
    });
});
