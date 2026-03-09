import { defineConfig } from "tsup";

export default defineConfig({
    entry: [
        "src/index.ts",
        "src/adapters/langchain.ts",
        "src/adapters/llamaindex.ts",
        "src/adapters/vercel-ai.ts",
    ],
    format: ["esm", "cjs"],
    dts: true,
    splitting: true,
    clean: true,
    sourcemap: true,
    external: ["@langchain/core", "llamaindex", "ai"],
});
