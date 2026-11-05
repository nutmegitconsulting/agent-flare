"""Opens the webapp's chat socket as the browser would, through the public origin."""
import asyncio
import sys

import websockets


async def main(host, ticket):
    url = f"ws://127.0.0.1:9120/api/ws?ticket={ticket}"
    headers = {"Host": host, "Origin": f"https://{host}", "X-Forwarded-Proto": "https"}
    async with websockets.connect(url, additional_headers=headers, open_timeout=15) as socket:
        await socket.send('{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}')
        reply = await asyncio.wait_for(socket.recv(), 15)
        print("connected; first frame:", str(reply)[:120])


asyncio.run(main(sys.argv[1], open("/tmp/ws-ticket").read().strip()))
