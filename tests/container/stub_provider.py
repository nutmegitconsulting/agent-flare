"""An OpenAI-compatible provider on loopback that records what Hermes sends it."""
import http.server
import json


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"object":"list","data":[{"id":"m1","object":"model"}]}')

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        with open("/tmp/stub.log", "a") as log:
            log.write(json.dumps({
                "auth": self.headers.get("authorization"), "gw": self.headers.get("cf-aig-gateway-id"),
                "meta": self.headers.get("cf-aig-metadata"), "model": body.get("model")}) + "\n")
        chunk = {"id": "c", "model": "m1", "choices": [{"index": 0, "finish_reason": "stop"}]}
        if body.get("stream"):
            chunk["object"] = "chat.completion.chunk"
            chunk["choices"][0]["delta"] = {"role": "assistant", "content": "stub-reply"}
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            self.wfile.write(f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n".encode())
        else:
            chunk["object"] = "chat.completion"
            chunk["choices"][0]["message"] = {"role": "assistant", "content": "stub-reply"}
            chunk["usage"] = {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(chunk).encode())


http.server.ThreadingHTTPServer(("127.0.0.1", 9555), Handler).serve_forever()
