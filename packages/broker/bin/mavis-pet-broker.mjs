#!/usr/bin/env node
// Bootstrap shim — loads the bundled CLI from dist/main.js if present,
// otherwise falls back to the TypeScript source via tsx (dev mode).
//
// We intentionally keep this script tiny so the heavy lifting lives in
// the Node bundle and stays type-checked.

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(here, "..", "dist", "main.js");
const srcEntry = resolve(here, "..", "src", "main.ts");

async function run() {
  if (existsSync(distEntry)) {
    const mod = await import(pathToFileURL(distEntry).href);
    if (typeof mod.main === "function") {
      await mod.main(process.argv.slice(2));
    }
    return;
  }
  // Dev fallback: rely on tsx if available.
  try {
    // @ts-ignore — optional dev dep
    await import("tsx/esm/api");
    const { tsImport } = await import("tsx/esm/api");
    const mod = await tsImport(pathToFileURL(srcEntry).href, import.meta.url);
    if (typeof mod.main === "function") {
      await mod.main(process.argv.slice(2));
    }
  } catch (err) {
    process.stderr.write(
      `mavis-pet-broker: dist/main.js not found and tsx fallback failed: ${(err && err.message) || err}\n`,
    );
    process.stderr.write(
      `Run: npm install && npm run build, then retry.\n`,
    );
    process.exit(1);
  }
}

run().catch((err) => {
  process.stderr.write(`mavis-pet-broker: fatal: ${(err && err.message) || err}\n`);
  process.exit(1);
});
