"""Acts like a browser behind the Worker: public URLs map to the container's port, and cookies
marked Secure are kept because the real browser's connection is HTTPS."""
import http.client
import json
import sys
from urllib.parse import urlsplit

HOST = sys.argv[1]
jar = {}
secure_flags = {}


def request(method, target, headers=None, body=None):
    connection = http.client.HTTPConnection("127.0.0.1", 9120, timeout=30)
    sent = {"Host": HOST, "X-Forwarded-Proto": "https", "X-Forwarded-Host": HOST, "Accept": "text/html"}
    if jar:
        sent["Cookie"] = "; ".join(f"{k}={v}" for k, v in jar.items())
    sent.update(headers or {})
    connection.request(method, target, body=body, headers=sent)
    response = connection.getresponse()
    data = response.read()
    for name, value in response.getheaders():
        if name.lower() == "set-cookie":
            pair, *attrs = value.split(";")
            key, _, val = pair.partition("=")
            secure_flags[key] = any(a.strip().lower() == "secure" for a in attrs)
            if val and val != '""':
                jar[key] = val
            else:
                jar.pop(key, None)
    return response.status, dict((k.lower(), v) for k, v in response.getheaders()), data


hops = []
target = "/"
for _ in range(10):
    status, headers, body = request("GET", target)
    hops.append((status, target.split("?")[0]))
    if status not in (301, 302, 303, 307):
        break
    location = urlsplit(headers["location"])
    if location.netloc not in ("", HOST):
        raise SystemExit(f"redirect left the site: {headers['location']}")
    target = location.path + ("?" + location.query if location.query else "")

out = {"hops": hops, "final_status": status, "html": b"<html" in body.lower()[:2000],
       "cookies": sorted(jar), "secure": secure_flags}
_, _, me = request("GET", "/api/auth/me", {"Accept": "application/json"})
out["me"] = json.loads(me)
same_site = {"Origin": f"https://{HOST}", "Sec-Fetch-Site": "same-origin", "Accept": "application/json"}
ticket_status, _, ticket = request("POST", "/api/auth/ws-ticket", same_site)
out["ticket_status"] = ticket_status
ticket = json.loads(ticket).get("ticket", "")
out["ticket"] = bool(ticket)
print(json.dumps(out))
if ticket:
    open("/tmp/ws-ticket", "w").write(ticket)
open("/tmp/cookie-header", "w").write("; ".join(f"{k}={v}" for k, v in jar.items()))
