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
