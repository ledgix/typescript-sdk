# ledgix-ts

[![npm](https://img.shields.io/badge/npm-v0.1.8-red)](https://www.npmjs.com/package/ledgix-ts)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Ledgix ALCV** — TypeScript SDK for SOX 404 compliance enforcement on AI agent tool calls.

The SDK acts as a **shim** that intercepts AI agent tool calls, sends clearance requests to an **ALCV Vault** server, and only allows execution if the Vault approves and returns a signed **A-JWT** (Agentic JSON Web Token, Ed25519/EdDSA).

## Installation

```bash
npm install ledgix-ts
```

### Optional Framework Adapters

```bash
# LangChain.js
npm install ledgix-ts @langchain/core

# LlamaIndex.ts
npm install ledgix-ts llamaindex

# Vercel AI SDK
npm install ledgix-ts ai
```

## Quick Start

```typescript
// ledgix.json
// {
//   "enforce": [
//     { "tool": "stripe*", "policyId": "financial-high-risk" },
//     { "tool": "*", "policyId": "default" }
//   ]
// }

import { configure, autoInstrument, currentToken } from "ledgix-ts";

const rawTools = {
  async stripeRefund(amount: number, reason: string) {
    const token = currentToken();
    return { refunded: amount, reason, token };
  },
};

configure({ agentId: "payments-agent" });

const tools = autoInstrument(rawTools);

const result = await tools.stripeRefund(45, "Late package");
console.log(result.token);
```

`autoInstrument()` reads `ledgix.json` from the current working directory by default, wraps matching functions automatically, and leaves unmatched entries unchanged.

## Configuration

| Option | Env Variable | Default | Description |
|---|---|---|---|
| `vaultUrl` | `LEDGIX_VAULT_URL` | `http://localhost:8000` | Vault server URL |
| `vaultApiKey` | `LEDGIX_VAULT_API_KEY` | `""` | API key for auth |
| `vaultTimeout` | `LEDGIX_VAULT_TIMEOUT` | `30000` | Timeout in ms |
| `verifyJwt` | `LEDGIX_VERIFY_JWT` | `true` | Auto-verify A-JWTs |
| `jwtIssuer` | `LEDGIX_JWT_ISSUER` | `alcv-vault` | Expected A-JWT issuer |
| `jwtAudience` | `LEDGIX_JWT_AUDIENCE` | `ledgix-sdk` | Expected A-JWT audience |
| `agentId` | `LEDGIX_AGENT_ID` | `"default-agent"` | Agent identifier |
| `sessionId` | `LEDGIX_SESSION_ID` | `""` | Session identifier |

## API Reference

### `LedgixClient`

```typescript
const client = new LedgixClient(config?);

await client.requestClearance(request);   // → ClearanceResponse
await client.registerPolicy(policy);      // → PolicyRegistrationResponse
await client.fetchJwks();                 // → JWKS object
await client.verifyToken(token);          // → decoded payload
await client.close();                     // cleanup
```

### `autoInstrument`

```typescript
import * as rawTools from "./tools.js";

const tools = autoInstrument(rawTools);
const toolsFromInline = autoInstrument(rawTools, {
  enforce: [{ tool: "stripe*", policyId: "financial-high-risk" }],
});
```

### `tool`

```typescript
const specialFn = tool(async function specialRefund(amount: number) {
  return currentToken();
});

const overrideFn = tool(
  async function stripeCharge(amount: number) {
    return currentToken();
  },
  { policyId: "override-policy" },
);
```

### `vaultEnforce` (Higher-Order Function)

```typescript
const guarded = vaultEnforce(client, {
  toolName: "my_tool",
  policyId: "policy-001",
  context: { key: "value" },
})(myAsyncFunction);
```

### `withVaultContext` (Callback Pattern)

```typescript
await withVaultContext(
  client,
  "stripe_refund",
  { amount: 45 },
  { policyId: "refund-policy" },
  async (clearance) => {
    // Use clearance.token
  },
);
```

### Framework Adapters

```typescript
// LangChain.js
import { wrapLangChainTool } from "ledgix-ts/adapters/langchain";

// LlamaIndex.ts
import { wrapTool } from "ledgix-ts/adapters/llamaindex";

// Vercel AI SDK
import { wrapVercelTool } from "ledgix-ts/adapters/vercel-ai";
```

## Error Handling

```typescript
import {
  ClearanceDeniedError,
  VaultConnectionError,
  TokenVerificationError,
  PolicyRegistrationError,
} from "ledgix-ts";
```

## Demo

```bash
npx tsx demo.ts
```

## License

MIT
