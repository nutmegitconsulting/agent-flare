#!/usr/bin/env node
// Writes wrangler.jsonc from wrangler.example.jsonc and environment variables, so the
// tracked repo holds no deployment details. Used locally and by the GitHub deploy workflow.
//   AF_HOSTNAME  ACCESS_TEAM_DOMAIN  ACCESS_AUD_TAG  AF_KV_ID   required
//   AF_R2_BUCKET  AF_ADMIN_EMAILS  AF_MAX_INSTANCES  AF_WORKER_NAME  AF_TEMPLATE_SECRETS   optional
//   AF_INSTANCE_TYPE   container size per user: a named type (standard-1) or custom vcpu,memory_mib,disk_mb
//                      (0.5,4096,16000); default standard-2
//   AF_IMAGE   a pushed registry image to run instead of building ./Dockerfile
//   AF_DEV_SANDBOX_WORKER  optional: sidecar Worker name; enables the per-user dev-sandbox feature
//   AF_WRANGLER_OUT   file to write; default wrangler.jsonc
import { readFileSync, writeFileSync } from "node:fs";

const env = process.env;

// "standard-1" stays a named type; "0.5,4096,16000" becomes a custom { vcpu, memory_mib, disk_mb }.
function instanceType(value) {
  const v = (value || "standard-2").trim();
  if (!v.includes(",")) return JSON.stringify(v);
  const [vcpu, memory_mib, disk_mb] = v.split(",").map(Number);
  if (![vcpu, memory_mib, disk_mb].every((n) => Number.isFinite(n) && n > 0)) {
    console.error(`AF_INSTANCE_TYPE "${v}": expected vcpu,memory_mib,disk_mb such as 0.5,4096,16000`);
    process.exit(1);
  }
  return JSON.stringify({ vcpu, memory_mib, disk_mb });
}
const missing = ["AF_HOSTNAME", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD_TAG", "AF_KV_ID"].filter((k) => !env[k]);
if (missing.length) {
  console.error(`missing: ${missing.join(", ")}`);
  process.exit(1);
}

const replacements = [
  ['"name": "agent-flare"', `"name": "${env.AF_WORKER_NAME || "agent-flare"}"`],
  ["agents.example.com", env.AF_HOSTNAME],
  ["your-team.cloudflareaccess.com", env.ACCESS_TEAM_DOMAIN],
  ["your-access-application-aud", env.ACCESS_AUD_TAG],
  ["YOUR_KV_NAMESPACE_ID", env.AF_KV_ID],
  ['"bucket_name": "agent-flare-state"', `"bucket_name": "${env.AF_R2_BUCKET || "agent-flare-state"}"`],
  ['"ADMIN_EMAILS": ""', `"ADMIN_EMAILS": "${env.AF_ADMIN_EMAILS || ""}"`],
  ['"max_instances": 10', `"max_instances": ${Number(env.AF_MAX_INSTANCES) || 10}`],
  ['"instance_type": "standard-2"', `"instance_type": ${instanceType(env.AF_INSTANCE_TYPE)}`],
  ['"TEMPLATE_SECRETS": ""', `"TEMPLATE_SECRETS": "${env.AF_TEMPLATE_SECRETS || ""}"`],
  ['"image": "./Dockerfile"', `"image": "${env.AF_IMAGE || "./Dockerfile"}"`],
];
let text = readFileSync("wrangler.example.jsonc", "utf8");

// Optional dev-sandbox service binding: rendered in with the sidecar Worker's name,
// or stripped entirely when AF_DEV_SANDBOX_WORKER is unset (feature off).
const blockStart = text.indexOf("// BEGIN_DEV_SANDBOX");
const blockEnd = text.indexOf("// END_DEV_SANDBOX");
if (blockStart === -1 || blockEnd === -1) throw new Error("template no longer contains the dev-sandbox block");
if (env.AF_DEV_SANDBOX_WORKER) {
  text = text.replace('"service": "DEV_SANDBOX_WORKER_NAME"', `"service": "${env.AF_DEV_SANDBOX_WORKER}"`);
} else {
  text = text.slice(0, blockStart) + text.slice(blockEnd + "// END_DEV_SANDBOX".length);
}

for (const [from, to] of replacements) {
  if (!text.includes(from)) throw new Error(`template no longer contains ${from}`);
  text = text.replace(from, to);
}
const out = env.AF_WRANGLER_OUT || "wrangler.jsonc";
writeFileSync(out, text);
console.log(`wrote ${out}`);
