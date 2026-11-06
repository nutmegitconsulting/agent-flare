#!/usr/bin/env node
// Upload config templates and assignments to R2.
//
//   node scripts/templates.mjs push <dir> [--bucket NAME]   templates/<name>/ -> templates/<name>/ in R2
//   node scripts/templates.mjs assign <file> [--bucket NAME]  a JSON file -> config/assignments.json
//   node scripts/templates.mjs tiers <file> [--bucket NAME]   a JSON file -> config/model-tiers.json
//   node scripts/templates.mjs check <dir>                  validate without uploading; lists secrets it needs
//
// Uses wrangler, so it runs with your wrangler login. Refuses anything that looks like a secret:
// R2 holds no secrets. Use "$NAME" in template env for Worker secrets.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { validateProviders } from "../src/providers.ts"; // Needs Node 22.18 or later.

const SECRET_NAMES = /(^|[_-])(key|token|secret|password|passwd|credential)s?($|[_-])/i;
const SECRET_VALUES = /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function check(dir) {
  const definitionPath = join(dir, "template.json");
  if (!existsSync(definitionPath)) fail(`${definitionPath} not found`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(basename(dir))) fail(`bad template name: ${basename(dir)}`);
  const definition = JSON.parse(readFileSync(definitionPath, "utf8"));
  for (const [key, value] of Object.entries(definition.env ?? {})) {
    if (SECRET_NAMES.test(key) && !String(value).startsWith("$")) {
      fail(`env ${key} looks like a secret. Use "$WORKER_SECRET_NAME" instead of a value.`);
    }
  }
  for (const [key, value] of Object.entries(definition.env ?? {})) {
    if (value === "$MASTER_KEY") fail(`env ${key}: templates can't read MASTER_KEY`);
  }
  const placeholders = readFileSync(definitionPath, "utf8").match(/YOUR_[A-Z0-9_]+/g);
  if (placeholders) fail(`fill these in first: ${[...new Set(placeholders)].join(", ")}`);
  if (definition.providers !== undefined) {
    const providers = validateProviders(definition.providers);
    if (!providers.ok) fail(`providers: ${providers.error}`);
    if (typeof definition.config_defaults?.model === "string") {
      fail("config_defaults.model is a string, which selects no provider. Remove it: the first provider with a credential is selected.");
    }
  }
  const filesDir = join(dir, "files");
  const onDisk = existsSync(filesDir) ? walk(filesDir).map((p) => relative(filesDir, p)) : [];
  for (const path of definition.files ?? []) {
    if (!onDisk.includes(path)) fail(`${path} is listed in template.json but not in files/`);
  }
  for (const path of onDisk) {
    if (!(definition.files ?? []).includes(path)) fail(`files/${path} is not listed in template.json`);
    if (/^(\.env|auth\.json)$/.test(basename(path))) fail(`files/${path} is a secrets file; it can't go in a template`);
    if (SECRET_VALUES.test(readFileSync(join(filesDir, path), "latin1"))) fail(`files/${path} appears to contain a credential`);
  }
  if (SECRET_VALUES.test(readFileSync(definitionPath, "utf8"))) fail("template.json appears to contain a credential");
  const secrets = Object.values(definition.env ?? {}).filter((v) => String(v).startsWith("$")).map((v) => v.slice(1));
  if (Array.isArray(definition.providers) && definition.providers.some((p) => p.mode === "api_token")) {
    secrets.push("CLOUDFLARE_AI_API_TOKEN");
  }
  return { definitionPath, filesDir, files: definition.files ?? [], secrets: [...new Set(secrets)] };
}

function put(bucket, key, file) {
  execFileSync("npx", ["wrangler", "r2", "object", "put", `${bucket}/${key}`, "--file", file, "--remote"],
    { stdio: ["ignore", "ignore", "inherit"] });
  console.log(`  ${key}`);
}

const [command, target, ...rest] = process.argv.slice(2);
const bucketFlag = rest.indexOf("--bucket");
const bucket = bucketFlag >= 0 ? rest[bucketFlag + 1] : "agent-flare-state";

if (command === "check" && target) {
  const { files, secrets } = check(target);
  console.log(`ok: ${files.length} file(s)`);
  if (secrets.length) console.log(`needs Worker secrets: ${secrets.join(", ")}. List any but CLOUDFLARE_AI_API_TOKEN in TEMPLATE_SECRETS.`);
} else if (command === "push" && target) {
  const { definitionPath, filesDir, files } = check(target);
  const name = basename(target);
  put(bucket, `templates/${name}/template.json`, definitionPath);
  for (const path of files) put(bucket, `templates/${name}/files/${path}`, join(filesDir, path));
} else if (command === "assign" && target) {
  JSON.parse(readFileSync(target, "utf8"));
  put(bucket, "config/assignments.json", target);
} else if (command === "tiers" && target) {
  for (const [model, tier] of Object.entries(JSON.parse(readFileSync(target, "utf8")))) {
    if (!["low", "medium", "high", "premium"].includes(tier)) fail(`${model}: tier must be low, medium, high or premium`);
  }
  put(bucket, "config/model-tiers.json", target);
} else {
  fail("usage: templates.mjs push <dir> | assign <file> | tiers <file> | check <dir> [--bucket NAME]");
}
