import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forbiddenTestSettings } from "../../src/test-settings";

function check(config: string) {
  const file = join(mkdtempSync(join(tmpdir(), "af-deploy-")), "w.jsonc");
  writeFileSync(file, config);
  return spawnSync("node", ["scripts/check-deploy.mjs", file], { encoding: "utf8" });
}

describe("local test settings", () => {
  it("make a deployed Worker refuse to serve", () => {
    expect(forbiddenTestSettings({ TEST_BACKUPS: "1" }, "agents.example.com")).toEqual(["TEST_BACKUPS"]);
    expect(forbiddenTestSettings({ ALLOW_TEST_JWKS: "1", TEST_JWKS: "{}" }, "agents.example.com")).toEqual(["ALLOW_TEST_JWKS", "TEST_JWKS"]);
    expect(forbiddenTestSettings({}, "agents.example.com")).toEqual([]);
  });
  it("still work locally", () => {
    expect(forbiddenTestSettings({ TEST_BACKUPS: "1", ALLOW_TEST_JWKS: "1" }, "localhost")).toEqual([]);
  });
  it("fail the deploy check", () => {
    for (const bad of ['{"vars":{"TEST_BACKUPS":"1"}}', '{"vars":{"ALLOW_TEST_JWKS":"1"}}', '{"workers_dev":true}', '{"images":{"build_vars":{}}}']) {
      expect(check(bad).status).toBe(1);
    }
    expect(check('{"workers_dev":false,"vars":{}}').status).toBe(0);
  });
  it("aren't in the example config a deploy is rendered from", () => {
    expect(spawnSync("node", ["scripts/check-deploy.mjs", "wrangler.example.jsonc"], { encoding: "utf8" }).status).toBe(0);
  });
});
