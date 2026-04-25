// Ledgix ALCV — Manifest Layer
// Schema, loading, and pattern matching for config-driven auto-instrumentation.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single enforcement rule declared in the manifest.
 */
export interface ManifestRule {
    /** Glob pattern matched against function names, e.g. `"stripe*"`. */
    tool: string;
    /** Policy ID to enforce for matching tools. */
    policyId?: string;
    /** Extra key/value pairs forwarded to the clearance request context. */
    context?: Record<string, unknown>;
}

/**
 * The raw shape of a parsed manifest file.
 */
export interface ManifestSchema {
    enforce: ManifestRule[];
}

const MANIFEST_FILENAMES = ["ledgix.json"] as const;

/**
 * Parsed enforcement manifest.
 *
 * Rules are evaluated in declaration order — the first match wins.
 */
export class Manifest {
    constructor(
        readonly rules: ManifestRule[],
        readonly source: string = "<inline>",
    ) {}

    /**
     * Return the first rule whose glob pattern matches *name*, or `undefined`.
     */
    match(name: string): ManifestRule | undefined {
        return this.rules.find((r) => _globMatch(r.tool, name));
    }

    toString(): string {
        return `Manifest(rules=${this.rules.length}, source=${JSON.stringify(this.source)})`;
    }
}

// ---------------------------------------------------------------------------
// loadManifest
// ---------------------------------------------------------------------------

/**
 * Load an enforcement manifest from a file, an inline object, or auto-discovery.
 *
 * Supported file formats:
 * - **JSON** (`.json`)
 *
 * When *source* is `undefined` the function searches the current working
 * directory for `ledgix.json`.
 *
 * ```json
 * {
 *   "enforce": [
 *     { "tool": "stripe*",   "policyId": "financial-high-risk" },
 *     { "tool": "dbWrite*",  "policyId": "data-mutation" },
 *     { "tool": "*",         "policyId": "default" }
 *   ]
 * }
 * ```
 *
 * @param source - File path, inline schema object, pre-built {@link Manifest},
 *   or `undefined` for auto-discovery.
 */
export function loadManifest(
    source?: string | ManifestSchema | Manifest,
): Manifest {
    if (source instanceof Manifest) return source;

    if (source == null) {
        const path = _findDefaultManifest();
        return _parseFile(path);
    }

    if (typeof source === "string") {
        if (!existsSync(source)) {
            throw new Error(`Ledgix manifest not found: ${source}`);
        }
        return _parseFile(source);
    }

    // Inline schema object
    return _fromSchema(source, "<inline>");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _findDefaultManifest(): string {
    for (const name of MANIFEST_FILENAMES) {
        const p = join(process.cwd(), name);
        if (existsSync(p)) return p;
    }
    throw new Error(
        "No Ledgix manifest found in the current directory. " +
        `Create one of: ${MANIFEST_FILENAMES.join(", ")}`,
    );
}

function _parseFile(path: string): Manifest {
    const content = readFileSync(path, "utf-8");
    if (!path.endsWith(".json")) {
        throw new Error(
            `Unsupported Ledgix manifest format: ${path}. TypeScript SDK manifests must be JSON.`,
        );
    }
    return _fromSchema(JSON.parse(content) as ManifestSchema, path);
}

function _fromSchema(schema: ManifestSchema, source: string): Manifest {
    return new Manifest(schema.enforce ?? [], source);
}

/** Minimal glob matching — supports `*` (any chars) and `?` (single char). */
export function _globMatch(pattern: string, name: string): boolean {
    const re = new RegExp(
        "^" +
            pattern
                .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                .replace(/\*/g, ".*")
                .replace(/\?/g, ".") +
            "$",
    );
    return re.test(name);
}
