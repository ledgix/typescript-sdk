import { defineConfig } from "tsup";

export default defineConfig({
    entry: [
        "src/index.ts",
        "src/adapters/langchain.ts",
        "src/adapters/llamaindex.ts",
        "src/adapters/vercel-ai.ts",
    ],
    format: ["esm", "cjs"],
    dts: false,
    splitting: false,
    platform: "node",
    clean: true,
    sourcemap: true,
    external: ["@langchain/core", "llamaindex", "ai", "node:async_hooks", "js-yaml"],
});
