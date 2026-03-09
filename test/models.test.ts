// Ledgix ALCV — Model Tests
// Tests for Zod schema validation, serialization, and case conversion

import { describe, expect, it } from "vitest";

import {
    ClearanceRequestSchema,
    ClearanceResponseSchema,
    PolicyRegistrationSchema,
    PolicyRegistrationResponseSchema,
    toCamelCaseKeys,
    toSnakeCaseKeys,
} from "../src/models.js";

// ──────────────────────────────────────────────────────────────────────
// ClearanceRequest
// ──────────────────────────────────────────────────────────────────────

describe("ClearanceRequestSchema", () => {
    it("should parse minimal input", () => {
        const req = ClearanceRequestSchema.parse({ toolName: "my_tool" });
        expect(req.toolName).toBe("my_tool");
        expect(req.toolArgs).toEqual({});
        expect(req.agentId).toBe("default-agent");
        expect(req.context).toEqual({});
    });

    it("should parse full input", () => {
        const req = ClearanceRequestSchema.parse({
            toolName: "stripe_refund",
            toolArgs: { amount: 45, reason: "late" },
            agentId: "agent-1",
            sessionId: "sess-1",
            context: { policyId: "refund-policy" },
        });
        expect(req.toolArgs.amount).toBe(45);
        expect(req.context.policyId).toBe("refund-policy");
    });

    it("should fail without required toolName", () => {
        expect(() => ClearanceRequestSchema.parse({})).toThrow();
    });

    it("should roundtrip through parse", () => {
        const original = {
            toolName: "test",
            toolArgs: { key: "value" },
            agentId: "default-agent",
            sessionId: "",
            context: {},
        };
        const parsed = ClearanceRequestSchema.parse(original);
        expect(parsed).toEqual(original);
    });
});

// ──────────────────────────────────────────────────────────────────────
// ClearanceResponse
// ──────────────────────────────────────────────────────────────────────

describe("ClearanceResponseSchema", () => {
    it("should parse approved response", () => {
        const resp = ClearanceResponseSchema.parse({
            approved: true,
            token: "eyJ...",
            reason: "All good",
            requestId: "req-1",
        });
        expect(resp.approved).toBe(true);
        expect(resp.token).toBe("eyJ...");
    });

    it("should parse denied response with defaults", () => {
        const resp = ClearanceResponseSchema.parse({
            approved: false,
            reason: "Policy violation",
            requestId: "req-2",
        });
        expect(resp.approved).toBe(false);
        expect(resp.token).toBeNull();
    });

    it("should parse from plain object", () => {
        const data = {
            approved: true,
            token: "abc",
            reason: "ok",
            requestId: "r1",
        };
        const resp = ClearanceResponseSchema.parse(data);
        expect(resp.approved).toBe(true);
    });
});

// ──────────────────────────────────────────────────────────────────────
// PolicyRegistration
// ──────────────────────────────────────────────────────────────────────

describe("PolicyRegistrationSchema", () => {
    it("should parse minimal input", () => {
        const policy = PolicyRegistrationSchema.parse({ policyId: "p1" });
        expect(policy.policyId).toBe("p1");
        expect(policy.rules).toEqual([]);
        expect(policy.tools).toEqual([]);
    });

    it("should parse full input", () => {
        const policy = PolicyRegistrationSchema.parse({
            policyId: "refund-policy",
            description: "Refund rules",
            rules: ["Max $100", "Original customer only"],
            tools: ["stripe_refund"],
        });
        expect(policy.rules).toHaveLength(2);
        expect(policy.tools).toContain("stripe_refund");
    });

    it("should fail without required policyId", () => {
        expect(() => PolicyRegistrationSchema.parse({})).toThrow();
    });
});

// ──────────────────────────────────────────────────────────────────────
// PolicyRegistrationResponse
// ──────────────────────────────────────────────────────────────────────

describe("PolicyRegistrationResponseSchema", () => {
    it("should parse with defaults", () => {
        const resp = PolicyRegistrationResponseSchema.parse({ policyId: "p1" });
        expect(resp.status).toBe("registered");
        expect(resp.message).toBe("");
    });

    it("should parse full response", () => {
        const resp = PolicyRegistrationResponseSchema.parse({
            policyId: "p1",
            status: "active",
            message: "Ready",
        });
        expect(resp.status).toBe("active");
    });
});

// ──────────────────────────────────────────────────────────────────────
// Case conversion utilities
// ──────────────────────────────────────────────────────────────────────

describe("Case conversion", () => {
    it("should convert camelCase to snake_case", () => {
        const input = {
            toolName: "test",
            toolArgs: { someValue: 42 },
            agentId: "agent-1",
            sessionId: "sess-1",
        };
        const result = toSnakeCaseKeys(input);
        expect(result).toEqual({
            tool_name: "test",
            tool_args: { some_value: 42 },
            agent_id: "agent-1",
            session_id: "sess-1",
        });
    });

    it("should convert snake_case to camelCase", () => {
        const input = {
            tool_name: "test",
            tool_args: { some_value: 42 },
            agent_id: "agent-1",
            request_id: "req-1",
        };
        const result = toCamelCaseKeys(input);
        expect(result).toEqual({
            toolName: "test",
            toolArgs: { someValue: 42 },
            agentId: "agent-1",
            requestId: "req-1",
        });
    });

    it("should handle arrays without converting keys in array elements", () => {
        const input = {
            policyId: "p1",
            rules: ["rule one", "rule two"],
        };
        const result = toSnakeCaseKeys(input);
        expect(result.rules).toEqual(["rule one", "rule two"]);
    });

    it("should roundtrip camelCase → snake_case → camelCase", () => {
        const original = {
            toolName: "stripe_refund",
            toolArgs: { amount: 45 },
            agentId: "my-agent",
            sessionId: "sess-1",
            context: {},
        };
        const snake = toSnakeCaseKeys(original);
        const restored = toCamelCaseKeys(snake);
        expect(restored).toEqual(original);
    });
});
