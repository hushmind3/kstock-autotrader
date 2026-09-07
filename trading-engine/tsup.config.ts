import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    setup: "src/setup.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  splitting: false,
  clean: true,
  sourcemap: true,
  noExternal: [/^@kstock\//],
  external: ["better-sqlite3", "@napi-rs/keyring", "ws"],
  outDir: "dist",
});
