// Ledgix ALCV — Retry-After / 429 backpressure tests
//
// Vault's Scale & Reliability §2.1 work added proactive backpressure: when
// the clearance queue is past its watermark, Vault emits 429 + Retry-After
// instead of blocking on a full channel. The SDK must:
//   1. Honor Retry-After verbatim (capped at 60s safety net).
//   2. NOT count 429s against the maxRetries budget — they're cooperative.
//   3. Give up after MAX_CONSECUTIVE_429 sustained 429s with QueueSaturatedError.
//   4. Fall back to jittered backoff if 429 has no/unparseable Retry-After.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { LedgixClient } from "../src/client.js";
import { QueueSaturatedError } from "../src/exceptions.js";
import type { ClearanceRequest } from "../src/models.js";
import { server, http, HttpResponse } from "./setup.js";
import {
    approvedResponse,
    createSampleJwt,
    createTestClient,
    generateTestKeys,
    type TestKeys,
} from "./helpers.js";

const sampleRequest: ClearanceRequest = {
    toolName: "stripe_refund",
    toolArgs: { amount: 25 },
    agentId: "test-agent",
    sessionId: "test-session",
    context: {},
};

describe("LedgixClient — 429 + Retry-After backpressure", () => {
    let client: LedgixClient;
    let keys: TestKeys;
    let sampleToken: string;
    /** Records every sleep duration the SDK requested, in ms. */
    let sleeps: number[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sleepSpy: any;

    beforeEach(async () => {
        client = createTestClient({ retryBaseDelay: 0, maxRetries: 0 });
        keys = await generateTestKeys();
        sampleToken = await createSampleJwt(keys.privateKey);
        sleeps = [];
        // Patch the private _sleep so tests don't actually wait. We record the
        // requested duration so we can assert Retry-After honoring. The cast
        // through `any` is intentional — vi.spyOn's strict generics fight
        // with reaching into a private method on the prototype.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sleepSpy = vi.spyOn(LedgixClient.prototype as any, "_sleep").mockImplementation((...args: unknown[]) => {
            sleeps.push(args[0] as number);
            return Promise.resolve();
        });
    });

    afterEach(() => {
        sleepSpy.mockRestore();
    });

    /** Build an MSW handler that returns the supplied response shapes in order
     *  (429 first, then approved, etc). Test assertions can read the call count. */
    function sequencedHandler(responses: Array<() => Response>) {
        let i = 0;
        return http.post("https://vault.test/request-clearance", () => {
            const r = responses[Math.min(i, responses.length - 1)]();
            i += 1;
            return r;
        });
    }

    it("honors Retry-After value verbatim (sleeps for header duration)", async () => {
        // Plan §4.1 case 1.
        server.use(
            sequencedHandler([
                () =>
                    new HttpResponse(JSON.stringify({ error: "queue near capacity" }), {
                        status: 429,
                        headers: { "Retry-After": "2", "Content-Type": "application/json" },
                    }),
                () => HttpResponse.json(approvedResponse(sampleToken)),
            ]),
        );

        const result = await client.requestClearance(sampleRequest);
        expect(result.decisionStatus).toBe("approved");

        // Exactly one sleep, of ~2000ms (Retry-After: 2 seconds).
        expect(sleeps.some((s) => Math.abs(s - 2000) < 1)).toBe(true);
    });

    it("falls back to jittered backoff when Retry-After is missing", async () => {
        // Plan §4.1 case 2. With retryBaseDelay=0 the jitter is also 0; the
        // important property is that we still sleep+retry rather than failing.
        server.use(
            sequencedHandler([
                () =>
                    new HttpResponse(JSON.stringify({ error: "queue near capacity" }), {
                        status: 429,
                        headers: { "Content-Type": "application/json" }, // no Retry-After
                    }),
                () => HttpResponse.json(approvedResponse(sampleToken)),
            ]),
        );

        const result = await client.requestClearance(sampleRequest);
        expect(result.decisionStatus).toBe("approved");
        expect(sleeps.length).toBeGreaterThanOrEqual(1);
    });

    it("does NOT consume the maxRetries budget on 429", async () => {
        // Plan §4.1 case 3. With maxRetries=0, a 5xx fails immediately, but
        // 429 is cooperative backoff so the SDK should ride out N waves and
        // still succeed.
        server.use(
            sequencedHandler([
                () =>
                    new HttpResponse(JSON.stringify({}), {
                        status: 429,
                        headers: { "Retry-After": "1", "Content-Type": "application/json" },
                    }),
                () =>
                    new HttpResponse(JSON.stringify({}), {
                        status: 429,
                        headers: { "Retry-After": "1", "Content-Type": "application/json" },
                    }),
                () =>
                    new HttpResponse(JSON.stringify({}), {
                        status: 429,
                        headers: { "Retry-After": "1", "Content-Type": "application/json" },
                    }),
                () => HttpResponse.json(approvedResponse(sampleToken)),
            ]),
        );

        const result = await client.requestClearance(sampleRequest);
        expect(result.decisionStatus).toBe("approved");
        // Three 429-driven sleeps before success.
        expect(sleeps.length).toBeGreaterThanOrEqual(3);
    });

    it("raises QueueSaturatedError after 10+ consecutive 429s", async () => {
        // Plan §4.1 case 4. MAX_CONSECUTIVE_429 = 10; the 11th wave trips it.
        server.use(
            http.post("https://vault.test/request-clearance", () => {
                return new HttpResponse(JSON.stringify({ error: "queue full" }), {
                    status: 429,
                    headers: { "Retry-After": "1", "Content-Type": "application/json" },
                });
            }),
        );

        await expect(client.requestClearance(sampleRequest)).rejects.toThrow(QueueSaturatedError);

        try {
            await client.requestClearance(sampleRequest);
        } catch (e) {
            const err = e as QueueSaturatedError;
            expect(err.attempts).toBeGreaterThanOrEqual(10);
            expect(err.lastRetryAfter).toBe(1);
        }
    });

    it("caps Retry-After at the 60s safety net (server-misbehavior guard)", async () => {
        server.use(
            sequencedHandler([
                () =>
                    new HttpResponse(JSON.stringify({}), {
                        status: 429,
                        headers: { "Retry-After": "9999", "Content-Type": "application/json" },
                    }),
                () => HttpResponse.json(approvedResponse(sampleToken)),
            ]),
        );

        await client.requestClearance(sampleRequest);
        // Largest sleep should be capped at 60_000 ms regardless of header.
        const maxSleep = Math.max(...sleeps);
        expect(maxSleep).toBeLessThanOrEqual(60_000);
        // And it should be the cap (60s), not zero.
        expect(maxSleep).toBeGreaterThanOrEqual(60_000);
    });

    it("ignores garbage Retry-After values and falls back to backoff", async () => {
        server.use(
            sequencedHandler([
                () =>
                    new HttpResponse(JSON.stringify({}), {
                        status: 429,
                        headers: {
                            "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT", // HTTP-date — not handled
                            "Content-Type": "application/json",
                        },
                    }),
                () => HttpResponse.json(approvedResponse(sampleToken)),
            ]),
        );

        const result = await client.requestClearance(sampleRequest);
        expect(result.decisionStatus).toBe("approved");
        // Should have slept (jitter fallback path), but not for any wall-clock
        // value derived from the date header.
        expect(sleeps.length).toBeGreaterThanOrEqual(1);
    });
});
