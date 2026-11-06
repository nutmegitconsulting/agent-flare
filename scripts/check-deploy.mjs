#!/usr/bin/env node
// Run before any deploy: refuses a config that would turn on local test behaviour.
//   node scripts/check-deploy.mjs wrangler.prod.jsonc
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "wrangler.jsonc";
const text = readFileSync(file, "utf8");
const problems = ["ALLOW_TEST_JWKS", "TEST_JWKS", "TEST_BACKUPS", "build_vars", "AF_BASE_IMAGE", "agent-flare-local-base"].filter((name) => text.includes(name));
if (/"workers_dev"\s*:\s*true/.test(text)) problems.push("workers_dev is on");
if (/"preview_urls"\s*:\s*true/.test(text)) problems.push("preview_urls is on");
if (problems.length) {
  console.error(`REFUSED: ${file} has: ${problems.join(", ")}`);
  process.exit(1);
}
console.log(`ok: ${file} has no local test settings`);
