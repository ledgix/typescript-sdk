// Ledgix ALCV — Exceptions
// All custom error classes for the SDK

/**
 * Base error for all Ledgix SDK errors.
 */
export class LedgixError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LedgixError";
    }
}

/**
 * Raised when the Vault denies a tool-call clearance request.
 */
export class ClearanceDeniedError extends LedgixError {
    public readonly reason: string;
    public readonly requestId: string | null;

    constructor(reason: string, requestId: string | null = null) {
        super(`Clearance denied: ${reason}`);
        this.name = "ClearanceDeniedError";
        this.reason = reason;
        this.requestId = requestId;
    }
}

export class ManualReviewTimeoutError extends LedgixError {
    public readonly requestId: string | null;

    constructor(requestId: string | null = null) {
        super(`Manual review timed out${requestId ? ` (${requestId})` : ""}`);
        this.name = "ManualReviewTimeoutError";
        this.requestId = requestId;
    }
}

/**
 * Raised when the SDK cannot reach the Vault server.
 */
export class VaultConnectionError extends LedgixError {
    constructor(message: string = "Unable to connect to the Vault server") {
        super(message);
        this.name = "VaultConnectionError";
    }
}

/**
 * Raised when A-JWT verification fails (bad signature, expired, etc.).
 */
export class TokenVerificationError extends LedgixError {
    constructor(message: string = "Token verification failed") {
        super(message);
        this.name = "TokenVerificationError";
    }
}

/**
 * Raised when a policy registration request fails.
 */
export class PolicyRegistrationError extends LedgixError {
    constructor(message: string = "Policy registration failed") {
        super(message);
        this.name = "PolicyRegistrationError";
    }
}

/**
 * Thrown in `reviewMode: "detach"` when a clearance enters pending-review status.
 *
 * The attached {@link pendingApproval} handle lets callers poll or cancel
 * without blocking the current async context.
 */
/**
 * Raised when an A-JWT jti has already been consumed by this SDK instance.
 *
 * Each A-JWT is single-use. Presenting the same token twice in the same
 * process raises this error so callers cannot accidentally reuse a spent
 * clearance. The SDK tracks jtis for the token's remaining TTL.
 */
export class ReplayDetectedError extends TokenVerificationError {
    public readonly jti: string | undefined;

    constructor(jti?: string) {
        super(`A-JWT replay detected${jti ? ` (jti=${jti})` : ""}`);
        this.name = "ReplayDetectedError";
        this.jti = jti;
    }
}

/**
 * Raised when Vault repeatedly responds with HTTP 429 (clearance queue near capacity).
 *
 * Vault emits 429 + Retry-After from its proactive backpressure check
 * (Scale & Reliability §2.1). The SDK honors the header and does NOT count
 * these waves against the normal `maxRetries` budget — they're cooperative
 * backoff, not failures. After `MAX_CONSECUTIVE_429` waves with no success,
 * however, the SDK gives up with this error so callers can fail fast instead
 * of looping indefinitely while the Vault is melting.
 */
export class QueueSaturatedError extends LedgixError {
    public readonly attempts: number;
    public readonly lastRetryAfter: number | null;

    constructor(attempts: number, lastRetryAfter: number | null = null) {
        const suffix = lastRetryAfter !== null ? ` (last Retry-After=${lastRetryAfter}s)` : "";
        super(
            `Vault clearance queue saturated after ${attempts} consecutive 429 responses${suffix}`,
        );
        this.name = "QueueSaturatedError";
        this.attempts = attempts;
        this.lastRetryAfter = lastRetryAfter;
    }
}

export class ReviewPendingError extends LedgixError {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public readonly pendingApproval: any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(pendingApproval: any) {
        super(`Clearance pending review (requestId=${pendingApproval.requestId})`);
        this.name = "ReviewPendingError";
        this.pendingApproval = pendingApproval;
    }
}
