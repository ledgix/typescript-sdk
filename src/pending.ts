// Ledgix ALCV — PendingApproval
// Handle for detached manual-review decisions

import type { LedgixClient } from "./client.js";
import { ClearanceDeniedError, ManualReviewTimeoutError } from "./exceptions.js";
import type { ClearanceResponse } from "./models.js";
import { ClearanceResponseSchema, toCamelCaseKeys } from "./models.js";

/**
 * Handle for a clearance request that entered `pending_review` status.
 *
 * Obtained when `reviewMode: "detach"` is set and the Vault returns a
 * `pending_review` response.  Call {@link wait} to resume polling when ready.
 *
 * ```ts
 * try {
 *   const clearance = await client.requestClearance(req);
 * } catch (err) {
 *   if (err instanceof ReviewPendingError) {
 *     const pending = err.pendingApproval as PendingApproval;
 *     // store pending.requestId, come back later:
 *     const clearance = await pending.wait();
 *   }
 * }
 * ```
 */
export class PendingApproval {
    public readonly requestId: string;
    private readonly _client: LedgixClient;

    constructor(requestId: string, client: LedgixClient, _initial: ClearanceResponse) {
        this.requestId = requestId;
        this._client = client;
    }

    /**
     * Poll `/clearance-status` until the reviewer decides, then return the clearance.
     *
     * @param timeoutMs - Max milliseconds to wait. Defaults to the client's `reviewTimeout`.
     * @throws {ManualReviewTimeoutError} If no decision arrives within `timeoutMs`.
     * @throws {ClearanceDeniedError} If the reviewer denies the request.
     */
    async wait(timeoutMs?: number): Promise<ClearanceResponse> {
        const timeout = timeoutMs ?? this._client.config.reviewTimeout;
        const poll = this._client.config.reviewPollInterval;
        const deadline = Date.now() + timeout;

        while (Date.now() < deadline) {
            await new Promise<void>((resolve) => setTimeout(resolve, poll));
            const response = await this._client["_fetch"](
                `/clearance-status/${encodeURIComponent(this.requestId)}`,
            );
            if (!response.ok) {
                continue; // transient error — keep polling
            }
            const data = await response.json();
            const clearance = ClearanceResponseSchema.parse(
                toCamelCaseKeys(data as Record<string, unknown>),
            );
            if (clearance.status !== "pendingReview" && clearance.status !== "processing") {
                if (!clearance.approved) {
                    throw new ClearanceDeniedError(clearance.reason, clearance.requestId || null);
                }
                return clearance;
            }
        }

        throw new ManualReviewTimeoutError(this.requestId);
    }

    /**
     * Cancel the pending review by posting a denial decision.
     *
     * Records a `review.cancelled_by_agent` entry in the Vault ledger.
     */
    async cancel(): Promise<void> {
        await this._client["_fetch"](`/reviews/${encodeURIComponent(this.requestId)}/decision`, {
            method: "POST",
            body: JSON.stringify({ approved: false, review_reason: "cancelled by agent" }),
        });
    }
}
