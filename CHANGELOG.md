# Changelog

All notable changes to `ledgix-ts` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0]

### Added
- `ClearanceRequest.destinationUri`, `destinationProvider`, and
  `destinationAccountRef` — typed counterparty attribution that replaces
  per-tool guessing in downstream policy checks. All three fields are
  optional; existing callers are unaffected.
- `extractCounterparty()` (re-exported from `ledgix-ts`) — best-effort
  SDK-side hint that fills the new fields when the caller doesn't supply
  them. Recognizes Stripe (`api_key` prefix → 12-char account ref),
  Twilio (`account_sid`), Slack (`team_id` / `workspace`), AWS Bedrock
  (`model_id`), OpenAI (`organization`), Anthropic (`organization`), and
  a generic URL-host fallback. The Vault re-runs its own extractor chain
  server-side, so this is a hint — caller-supplied values always win.
- `/mint-token` cache-replay path forwards the destination fields so
  re-minted A-JWTs share attribution with the original decision.

### Compatibility
- Backwards-compatible against Vault 0.x (Vault ignores unknown wire
  fields prior to the matching schema migration). Older SDKs continue
  to work against the new Vault — destination columns are simply NULL
  on those rows.

## [0.2.1]
- Honor `Retry-After` on 429 from Vault backpressure.

## [0.2.0]
- Initial 0.2.x line: Idempotency-Key on POSTs, JWKS kid matching,
  jti replay detection, HITL `PendingApproval` + `verify_webhook`.
