"""One real chat turn over the webapp's socket, as the browser sends it. Prints what happened."""
import asyncio
import json
import sys
import uuid

import websockets

PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 9120


async def main(host, ticket):
    url = f"ws://127.0.0.1:{PORT}/api/ws?ticket={ticket}"
    headers = {"Host": host, "Origin": f"https://{host}", "X-Forwarded-Proto": "https"}
    out = {"events": []}
    async with websockets.connect(url, additional_headers=headers, open_timeout=15, max_size=None) as socket:
        pending = {}

        async def call(method, params, rid):
            await socket.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}))
            pending[rid] = method

        await call("setup.status", {}, 1)
        await call("session.create", {}, 2)
        deadline = asyncio.get_running_loop().time() + 100
        while asyncio.get_running_loop().time() < deadline:
            try:
                frame = json.loads(await asyncio.wait_for(socket.recv(), 15))
            except asyncio.TimeoutError:
                continue
            if frame.get("id") in pending:
                method = pending.pop(frame["id"])
                result = frame.get("result", frame.get("error"))
                out[method] = result if method != "session.create" else {"ok": "session_id" in (result or {}), "error": frame.get("error")}
                if method == "session.create" and "error" not in frame:
                    await call("prompt.submit", {"session_id": frame["result"]["session_id"], "text": "say hi",
                                                 "submission_id": uuid.uuid4().hex}, 3)
                elif method == "session.create" and frame["error"].get("message") == "storage_unavailable":
                    # The browser retries this too: the store opens just after the socket does.
                    await asyncio.sleep(1)
                    await call("session.create", {}, 2)
                continue
            params = frame.get("params") or {}
            kind = params.get("type")
            if kind:
                out["events"].append(kind)
                if kind not in ("message.delta", "thinking.delta", "reasoning.delta", "status.update"):
                    print("event", kind, str(params.get("payload"))[:300], file=sys.stderr, flush=True)
            if kind == "message.complete":
                out["reply"] = (params.get("payload") or {}).get("text", "")
                break
            if kind == "error":
                out["error"] = str((params.get("payload") or {}).get("message", ""))[:400]
                break
    print(json.dumps(out))


asyncio.run(main(sys.argv[1], open("/tmp/ws-ticket").read().strip()))
