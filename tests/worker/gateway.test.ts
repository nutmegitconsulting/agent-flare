import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(public ctx: unknown, public env: unknown) {}
  },
}));

const { SandboxGateway, sandboxKeyFor } = await import("../../src/gateway");

function gateway(sub: string | undefined, binding?: { fetch: (request: Request) => Promise<Response> }) {
  const Gateway = SandboxGateway as unknown as new (ctx: unknown, env: unknown) => { fetch(request: Request): Promise<Response> };
  return new Gateway({ props: sub ? { sub } : undefined }, { DEV_SANDBOX: binding });
}

describe("SandboxGateway", () => {
  it("stamps the key from the verified identity and drops what the container sent", async () => {
    const seen: Request[] = [];
    const reply = new Response("{}");
    const binding = { fetch: async (request: Request) => (seen.push(request), reply) };
    const response = await gateway("User-123", binding).fetch(new Request("http://cfsandbox.internal/exec", {
      method: "POST",
      body: '{"command":"id"}',
      headers: { "X-Sandbox-Key": "someone-else", Authorization: "Bearer x", "CF-Access-Client-Id": "a", "CF-Access-Client-Secret": "b" },
    }));
    expect(response).toBe(reply);
    expect(seen[0].headers.get("X-Sandbox-Key")).toBe(sandboxKeyFor("User-123"));
    expect(seen[0].headers.get("Authorization")).toBeNull();
    expect(seen[0].headers.get("CF-Access-Client-Id")).toBeNull();
    expect(await seen[0].text()).toBe('{"command":"id"}');
  });

  it("passes the shell's WebSocket upgrade through with the same stamped key", async () => {
    const seen: Request[] = [];
    const reply = new Response(null, { status: 200 });
    const binding = { fetch: async (request: Request) => (seen.push(request), reply) };
    const response = await gateway("user-123", binding).fetch(new Request("http://cfsandbox.internal/pty?cols=90&rows=25&cwd=%2Fworkspace", {
      headers: { Upgrade: "websocket", "X-Sandbox-Key": "someone-else--default" },
    }));
    expect(response).toBe(reply);
    expect(seen[0].method).toBe("GET");
    expect(new URL(seen[0].url).search).toBe("?cols=90&rows=25&cwd=%2Fworkspace");
    expect(seen[0].headers.get("Upgrade")).toBe("websocket");
    expect(seen[0].headers.get("X-Sandbox-Key")).toBe("af-user-123");
  });

  it("refuses when the feature is off or there is no identity", async () => {
    expect((await gateway("user-123").fetch(new Request("http://cfsandbox.internal/home"))).status).toBe(503);
    expect((await gateway(undefined, { fetch: async () => new Response() }).fetch(new Request("http://cfsandbox.internal/home"))).status).toBe(500);
  });
});
