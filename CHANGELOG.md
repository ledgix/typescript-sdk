# Changelog

All notable changes to `ledgix-ts` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1]

### Added
- `ClearanceRequest.dataCategories`, `purpose`, and `processingRegisterRef` —
  Phase 2 GDPR Article 30 processing-register matching. When set, the
  Vault's pre-LLM validator chain checks for an active register that covers
  the (data_categories ⊇ requested, purpose ∈ register.purposes,
  recipient ∈ register.recipients) tuple. Unmatched requests deny with
  `reasonCode='processing_no_register_match'`.
- `ClearanceRequest.datasetRef` — Phase 6 dataset lineage. Logical
  reference (filename, S3 path, table name, etc.) for the production data
  this action reads/writes. Auto-derived dataset sheets group on this field
  for row counts, schema fingerprints, and consent-basis breakdowns.
- All four fields are also surfaced as options on `enforce()`, `tool()`,
  `vaultEnforce()`, `withVaultContext()`, and `BuildRequestOptions` so the
  high-level HOFs and adapter helpers can populate them without dropping
  to `LedgixClient.requestClearance` directly.
- `/mint-token` cache-replay forwards the new fields alongside the 0.3.0
  destination set so re-minted A-JWTs retain register/dataset attribution.

### Compatibility
- Backwards-compatible. All four fields are optional. Vault ignores unknown
  wire fields prior to the matching schema migration; older SDKs continue
  to work against the new Vault.

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
