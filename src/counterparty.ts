// Ledgix ALCV — Client-side counterparty hints
//
// Mirrors vault/internal/counterparty: best-effort extraction of the
// destination provider/URI/account from a tool name + tool_args.
// The Vault re-runs its own extractor chain, so this is a hint to
// pre-populate the wire fields when the SDK has unambiguous signal.
//
// Caller-supplied destination_* always wins on both sides of the wire.

export interface CounterpartyHint {
    destinationUri?: string;
    destinationProvider?: string;
    destinationAccountRef?: string;
}

const PROVIDER_HOST_PREFIXES = ["www.", "api.", "api-"];

function providerFromHost(host: string): string {
    const lower = host.toLowerCase().split(":", 1)[0]!;
    for (const prefix of PROVIDER_HOST_PREFIXES) {
        if (lower.startsWith(prefix)) return lower.slice(prefix.length);
    }
    return lower;
}

function stringArg(args: Record<string, unknown>, key: string): string {
    const v = args[key];
    return typeof v === "string" ? v : "";
}

type Extractor = (toolNameLower: string, args: Record<string, unknown>) => CounterpartyHint | null;

const stripeExtractor: Extractor = (tool, args) => {
    if (!tool.includes("stripe")) return null;
    const out: CounterpartyHint = {
        destinationUri: "https://api.stripe.com",
        destinationProvider: "stripe",
    };
    const apiKey = stringArg(args, "api_key");
    if (apiKey.startsWith("sk_")) {
        out.destinationAccountRef = apiKey.length >= 12 ? apiKey.slice(0, 12) : apiKey;
    }
    const account = stringArg(args, "account");
    if (account) out.destinationAccountRef = account;
    return out;
};

const twilioExtractor: Extractor = (tool, args) => {
    if (!tool.includes("twilio")) return null;
    const out: CounterpartyHint = {
        destinationUri: "https://api.twilio.com",
        destinationProvider: "twilio",
    };
    const sid = stringArg(args, "account_sid");
    if (sid) out.destinationAccountRef = sid;
    return out;
};

const slackExtractor: Extractor = (tool, args) => {
    if (!tool.includes("slack")) return null;
    const out: CounterpartyHint = {
        destinationUri: "https://slack.com/api",
        destinationProvider: "slack",
    };
    const team = stringArg(args, "team_id") || stringArg(args, "workspace");
    if (team) out.destinationAccountRef = team;
    return out;
};

const bedrockExtractor: Extractor = (tool, args) => {
    if (!tool.includes("bedrock")) return null;
    const out: CounterpartyHint = {
        destinationUri: "https://bedrock-runtime.amazonaws.com",
        destinationProvider: "aws-bedrock",
    };
    const modelId = stringArg(args, "model_id") || stringArg(args, "model");
    if (modelId) out.destinationAccountRef = modelId;
    return out;
};

const openaiExtractor: Extractor = (tool, args) => {
    if (!tool.includes("openai") && !tool.includes("gpt")) return null;
    const out: CounterpartyHint = {
        destinationUri: "https://api.openai.com",
        destinationProvider: "openai",
    };
    const org = stringArg(args, "organization") || stringArg(args, "org_id");
    if (org) out.destinationAccountRef = org;
    return out;
};

const anthropicExtractor: Extractor = (tool, args) => {
    if (!tool.includes("anthropic") && !tool.includes("claude")) return null;
    const out: CounterpartyHint = {
        destinationUri: "https://api.anthropic.com",
        destinationProvider: "anthropic",
    };
    const org = stringArg(args, "organization");
    if (org) out.destinationAccountRef = org;
    return out;
};

const genericHttpExtractor: Extractor = (_tool, args) => {
    for (const key of ["url", "endpoint", "uri", "host"]) {
        const raw = stringArg(args, key);
        if (!raw) continue;
        try {
            const parsed = new URL(raw);
            if (!parsed.host) continue;
            return {
                destinationUri: raw,
                destinationProvider: providerFromHost(parsed.host),
            };
        } catch {
            continue;
        }
    }
    return null;
};

const EXTRACTORS: readonly Extractor[] = [
    stripeExtractor,
    twilioExtractor,
    slackExtractor,
    bedrockExtractor,
    openaiExtractor,
    anthropicExtractor,
    genericHttpExtractor,
];

/** Return any inferred destination_* fields. Empty object on no match. */
export function extractCounterparty(
    toolName: string,
    toolArgs: Record<string, unknown> | undefined,
): CounterpartyHint {
    if (!toolName) return {};
    const nameLower = toolName.toLowerCase();
    const args = toolArgs ?? {};
    for (const ex of EXTRACTORS) {
        const result = ex(nameLower, args);
        if (result) return result;
    }
    return {};
}
