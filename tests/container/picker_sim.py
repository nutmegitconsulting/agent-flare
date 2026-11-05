"""Asks for the model picker's data over the webapp's socket, the way the browser does. Prints JSON."""
import asyncio
import json
import sys

import websockets


async def main(host, ticket):
    url = f"ws://127.0.0.1:9120/api/ws?ticket={ticket}"
    headers = {"Host": host, "Origin": f"https://{host}", "X-Forwarded-Proto": "https"}
    async with websockets.connect(url, additional_headers=headers, open_timeout=15, max_size=None) as socket:
        await socket.send(json.dumps({"jsonrpc": "2.0", "id": 7, "method": "model.options", "params": {}}))
        while True:
            frame = json.loads(await asyncio.wait_for(socket.recv(), 60))
            if frame.get("id") == 7:
                rows = (frame.get("result") or {}).get("providers", [])
                print(json.dumps({"error": frame.get("error"), "providers": [
                    {"slug": r.get("slug"), "models": r.get("models"), "pricing": r.get("pricing")} for r in rows]}))
                return


asyncio.run(main(sys.argv[1], open("/tmp/ws-ticket").read().strip()))
