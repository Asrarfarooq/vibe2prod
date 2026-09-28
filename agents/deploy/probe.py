import re
import time
from pathlib import Path

import requests

SECURITY_HEADERS = (
    "strict-transport-security",
    "content-security-policy",
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
)
API_ROUTE = re.compile(r"""\.get\(\s*["'`](/api/[A-Za-z0-9_\-/]*)["'`]""")
SOURCE_SUFFIXES = {".js", ".mjs", ".cjs", ".ts"}
SKIP_DIRS = {"node_modules", "dist", ".git", "infra"}
MISSING_PATH = "/v2p-probe-missing-route"


def find_api_path(root: Path) -> str | None:
    """First parameterless GET /api route in the server code, so the probe hits a real endpoint."""
    files = [
        p
        for p in sorted(root.rglob("*"))
        if p.suffix in SOURCE_SUFFIXES
        and not SKIP_DIRS.intersection(p.relative_to(root).parts)
    ]
    # Frontend code under src/ also calls .get("/api/..."); server files are more reliable.
    files.sort(key=lambda p: "src" in p.relative_to(root).parts)
    for path in files:
        match = API_ROUTE.search(path.read_text(errors="ignore"))
        if match:
            return match.group(1)
    return None


def _get(url: str, timeout: float = 30, **kwargs) -> dict:
    start = time.monotonic()
    try:
        resp = requests.get(url, timeout=timeout, **kwargs)
    except requests.RequestException as err:
        return {
            "url": url,
            "error": f"{err.__class__.__name__}: {str(err)[:200]}",
            "latency_ms": None,
        }
    return {
        "url": url,
        "status": resp.status_code,
        "latency_ms": round((time.monotonic() - start) * 1000),
        "content_type": resp.headers.get("content-type", ""),
        "headers": {k.lower(): v for k, v in resp.headers.items()},
        "location": resp.headers.get("location"),
        "body": resp.text[:500],
    }


def probe(
    base_url: str, api_path: str | None, attempts: int = 12, delay: float = 5
) -> dict:
    """Waits for the app to answer on /, then records first-hit latency, API, 404 and HTTP behavior."""
    base = base_url.rstrip("/")
    first = None
    for attempt in range(attempts):
        first = _get(base + "/")
        if first.get("status") == 200:
            break
        time.sleep(delay * min(attempt + 1, 4))
    warm = _get(base + "/")
    result = {
        "root": first,
        "root_warm": warm,
        "cold_start_ms": first.get("latency_ms") if first else None,
        "api": _get(base + api_path) if api_path else None,
        "missing": _get(base + MISSING_PATH),
        "http": _get(
            "http://" + base.removeprefix("https://") + "/", allow_redirects=False
        )
        if base.startswith("https://")
        else None,
    }
    headers = (warm or {}).get("headers") or {}
    result["security_headers"] = {h: h in headers for h in SECURITY_HEADERS}
    result["x_powered_by"] = headers.get("x-powered-by")
    return result


def compact(result: dict) -> dict:
    """Probe result without full header maps, for events and the model prompt."""
    out = {}
    for key, value in result.items():
        if isinstance(value, dict) and "url" in value:
            out[key] = {k: v for k, v in value.items() if k != "headers"}
        else:
            out[key] = value
    return out
