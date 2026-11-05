"""Dashboard auth provider: sign in to the Hermes webapp with the Cloudflare Access identity.

Access already authenticated the browser before the request reached this container. The Worker
verifies the Access JWT, sends the request only to the sandbox owned by that identity, and writes
the identity to AUTH_FILE. A second login would add nothing, so this provider completes the OAuth
round trip Hermes expects without showing anything: ``start_login`` redirects straight to the
callback, and the gate's auto-SSO makes that invisible to the user.

Security boundary: the container has no public ingress. The Worker is the only way in, and it
refuses any request without a valid Access JWT for the owner of this sandbox. Code and tokens are
HMAC-signed with a per-user secret the Worker derives, so they can't be forged from a browser, and
a token from one user's container is useless in another's.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
import urllib.parse
from pathlib import Path
from typing import Optional

from hermes_cli.dashboard_auth import (
    DashboardAuthProvider, InvalidCodeError, LoginStart, RefreshExpiredError, Session)

logger = logging.getLogger(__name__)
_TAG = "dashboard-auth[cloudflare-access]"

AUTH_FILE = Path(os.environ.get("AGENT_FLARE_AUTH_FILE", "/run/agent-flare/auth.json"))
CODE_TTL_SECONDS = 60
ACCESS_TTL_SECONDS = 12 * 60 * 60
REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60
LAST_SKIP_REASON = ""


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _load_identity() -> dict:
    """The owner the Worker wrote. Re-read on use, so a rotated secret applies without a restart."""
    data = json.loads(AUTH_FILE.read_text(encoding="utf-8"))
    if not data.get("secret") or not data.get("sub"):
        raise ValueError(f"{AUTH_FILE} is missing secret or sub")
    return data


class CloudflareAccessProvider(DashboardAuthProvider):
    name = "cloudflare-access"
    display_name = "Cloudflare Access"
    supports_password = False
    supports_session = True
    interactive_login = True

    def _sign(self, kind: str, ttl: int, identity: dict) -> str:
        body = _b64(json.dumps(
            {"k": kind, "sub": identity["sub"], "exp": int(time.time()) + ttl,
             "n": secrets.token_urlsafe(8)}, separators=(",", ":")).encode())
        mac = hmac.new(identity["secret"].encode(), body.encode(), hashlib.sha256).digest()
        return f"{body}.{_b64(mac)}"

    def _read(self, token: str, kind: str, identity: dict) -> Optional[dict]:
        """The token's claims when it's ours, the right kind, for this owner and unexpired."""
        try:
            body, mac = token.split(".", 1)
            expected = hmac.new(identity["secret"].encode(), body.encode(), hashlib.sha256).digest()
            if not hmac.compare_digest(_unb64(mac), expected):
                return None
            claims = json.loads(_unb64(body))
        except (ValueError, TypeError):
            return None
        if claims.get("k") != kind or claims.get("sub") != identity["sub"]:
            return None
        return claims if int(claims.get("exp", 0)) > time.time() else None

    def _session(self, identity: dict, refresh_token: str = "") -> Session:
        return Session(
            user_id=identity["sub"], email=identity.get("email", ""),
            display_name=identity.get("name") or identity.get("email", "") or "Access user",
            org_id="", provider=self.name,
            expires_at=int(time.time()) + ACCESS_TTL_SECONDS,
            access_token=self._sign("at", ACCESS_TTL_SECONDS, identity),
            refresh_token=refresh_token or self._sign("rt", REFRESH_TTL_SECONDS, identity),
            issuer=identity.get("issuer", ""))

    def start_login(self, *, redirect_uri: str) -> LoginStart:
        state = secrets.token_urlsafe(16)
        code = self._sign("code", CODE_TTL_SECONDS, _load_identity())
        query = urllib.parse.urlencode({"code": code, "state": state})
        return LoginStart(
            redirect_url=f"{redirect_uri}?{query}",
            cookie_payload={"hermes_session_pkce": f"state={state};verifier=unused"})

    def complete_login(self, *, code: str, state: str, code_verifier: str, redirect_uri: str) -> Session:
        identity = _load_identity()
        if self._read(code, "code", identity) is None:
            raise InvalidCodeError("sign-in code is invalid or expired")
        return self._session(identity)

    def verify_session(self, *, access_token: str) -> Optional[Session]:
        identity = _load_identity()
        claims = self._read(access_token, "at", identity)
        if claims is None:
            return None
        return Session(
            user_id=identity["sub"], email=identity.get("email", ""),
            display_name=identity.get("name") or identity.get("email", "") or "Access user",
            org_id="", provider=self.name, expires_at=int(claims["exp"]),
            access_token=access_token, refresh_token="", issuer=identity.get("issuer", ""))

    def refresh_session(self, *, refresh_token: str) -> Session:
        identity = _load_identity()
        if self._read(refresh_token, "rt", identity) is None:
            raise RefreshExpiredError("refresh token is not valid for this provider")
        return self._session(identity, refresh_token=self._sign("rt", REFRESH_TTL_SECONDS, identity))

    def revoke_session(self, *, refresh_token: str) -> None:
        # Stateless. Access remains the real session; revoking there ends access.
        return None


def register(ctx) -> None:
    """Register unconditionally in this image: the listener must start before the Worker has
    anything else to say, and a missing identity file fails the sign-in closed, not open."""
    global LAST_SKIP_REASON
    LAST_SKIP_REASON = ""
    ctx.register_dashboard_auth_provider(CloudflareAccessProvider())
    logger.info("%s: registered", _TAG)
