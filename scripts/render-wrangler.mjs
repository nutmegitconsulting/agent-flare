#!/usr/bin/env node
// Writes wrangler.jsonc from wrangler.example.jsonc and environment variables, so the
// tracked repo holds no deployment details. Used locally and by the GitHub deploy workflow.
//   AF_HOSTNAME  ACCESS_TEAM_DOMAIN  ACCESS_AUD_TAG  AF_KV_ID   required
//   AF_R2_BUCKET  AF_ADMIN_EMAILS  AF_MAX_INSTANCES  AF_WORKER_NAME  AF_TEMPLATE_SECRETS   optional
//   AF_IMAGE   a pushed registry image to run instead of building ./Dockerfile
//   AF_WRANGLER_OUT   file to write; default wrangler.jsonc
import { readFileSync, writeFileSync } from "node:fs";

const env = process.env;
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
  ['"TEMPLATE_SECRETS": ""', `"TEMPLATE_SECRETS": "${env.AF_TEMPLATE_SECRETS || ""}"`],
  ['"image": "./Dockerfile"', `"image": "${env.AF_IMAGE || "./Dockerfile"}"`],
];
let text = readFileSync("wrangler.example.jsonc", "utf8");
for (const [from, to] of replacements) {
  if (!text.includes(from)) throw new Error(`template no longer contains ${from}`);
  text = text.replace(from, to);
}
const out = env.AF_WRANGLER_OUT || "wrangler.jsonc";
writeFileSync(out, text);
console.log(`wrote ${out}`);
