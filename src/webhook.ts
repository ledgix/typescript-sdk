// Ledgix ALCV — Webhook verification helper

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify the HMAC-SHA256 signature on an inbound Ledgix webhook.
 *
 * The Vault signs every delivery with `X-Ledgix-Signature: sha256=<hex>`.
 * Pass the raw request body, that header value, and your endpoint's signing
 * secret to verify authenticity before processing the event.
 *
 * @param body - Raw request body (string or Buffer). Use the unparsed body
 *   exactly as received — do not re-stringify from a parsed object.
 * @param signature - Value of the `X-Ledgix-Signature` header.
 * @param secret - Signing secret for this webhook endpoint (from the dashboard).
 * @returns `true` if the signature is valid, `false` otherwise.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { verifyWebhook } from "ledgix-ts";
 *
 * app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
 *   if (!verifyWebhook(req.body, req.headers["x-ledgix-signature"] as string, SECRET)) {
 *     return res.status(403).send("Forbidden");
 *   }
 *   // ship-safe-ignore WEBHOOK_RAW_BODY_NOT_USED — this is a doc comment example, not executed code
 *   const event = JSON.parse(req.body.toString());
 *   // ...
 * });
 * ```
 */
export function verifyWebhook(
    body: string | Buffer,
    signature: string,
    secret: string,
): boolean {
    const sigHex = signature.startsWith("sha256=") ? signature.slice(7) : signature;
    const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf-8") : body;
    const expected = createHmac("sha256", secret).update(bodyBuf).digest("hex");

    try {
        return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sigHex, "hex"));
    } catch {
        return false;
    }
}
