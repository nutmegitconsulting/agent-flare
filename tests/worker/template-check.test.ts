import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function check(dir: string) {
  const run = spawnSync("node", ["scripts/templates.mjs", "check", dir], { encoding: "utf8" });
  return { status: run.status, output: run.stdout + run.stderr };
}

function filledExample(edit: (t: Record<string, any>) => void = () => undefined) {
  const dir = join(mkdtempSync(join(tmpdir(), "af-template-")), "team");
  cpSync("templates/example", dir, { recursive: true });
  const text = readFileSync(join(dir, "template.json"), "utf8")
    .replaceAll("YOUR_ACCOUNT_ID", "acct").replaceAll("YOUR_GATEWAY_ID", "gw")
    .replaceAll("YOUR_OPENAI_COMPATIBLE_HOST", "llm.example.com").replaceAll("YOUR_MODEL_ID", "some-model");
  const template = JSON.parse(text);
  edit(template);
  writeFileSync(join(dir, "template.json"), JSON.stringify(template));
  return dir;
}

describe("templates.mjs check", () => {
  it("refuses the example until its placeholders are filled, and names them", () => {
    const result = check("templates/example");
    expect(result.status).toBe(1);
    expect(result.output).toContain("YOUR_ACCOUNT_ID");
  });
  it("passes the example once filled, and lists the secret it needs", () => {
    const result = check(filledExample());
    expect(result.output).toContain("CLOUDFLARE_AI_API_TOKEN");
    expect(result.status).toBe(0);
  });
  it("refuses a provider it can't route or a credential in a header", () => {
    expect(check(filledExample((t) => { t.providers[0].name = "openrouter"; })).status).toBe(1);
    expect(check(filledExample((t) => { t.providers[0].extra_headers = { Authorization: "Bearer abc" }; })).status).toBe(1);
  });
  it("refuses a bare model string, which would select no provider", () => {
    const result = check(filledExample((t) => { t.config_defaults = { model: "some-model" }; }));
    expect(result.status).toBe(1);
    expect(result.output).toContain("selects no provider");
  });
  it("refuses a secret value in env", () => {
    expect(check(filledExample((t) => { t.env = { MY_API_KEY: "abc" }; })).status).toBe(1);
    expect(check(filledExample((t) => { t.env = { MY_API_KEY: "$SHARED" }; })).output).toContain("SHARED");
  });
});
