import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from deploy import audit, probe

IMAGE = "us-central1-docker.pkg.dev/p/vibe2prod/app-r@sha256:abc"


def live_service(**overrides):
    svc = {
        "labels": {"v2p-run": "r"},
        "latestReadyRevision": "projects/p/locations/l/services/app-r/revisions/app-r-001",
        "latestCreatedRevision": "projects/p/locations/l/services/app-r/revisions/app-r-001",
        "terminalCondition": {"type": "Ready", "state": "CONDITION_SUCCEEDED"},
        "template": {
            "serviceAccount": "app-r@p.iam.gserviceaccount.com",
            "timeout": "300s",
            "scaling": {"maxInstanceCount": 3},
            "containers": [
                {
                    "image": IMAGE,
                    "resources": {"limits": {"cpu": "1", "memory": "512Mi"}},
                    "startupProbe": {"tcpSocket": {"port": 8080}},
                    "env": [
                        {"name": "NODE_ENV", "value": "production"},
                        {
                            "name": "GEMINI_API_KEY",
                            "valueSource": {
                                "secretKeyRef": {
                                    "secret": "app-r-gemini",
                                    "version": "latest",
                                }
                            },
                        },
                    ],
                }
            ],
        },
    }
    svc.update(overrides)
    return svc


PROBE_OK = {
    "root": {"url": "https://app-r.run.app/", "status": 200},
    "api": {"url": "https://app-r.run.app/api/notes", "status": 200},
    "http": {"status": 302},
    "cold_start_ms": 1200,
    "security_headers": {h: True for h in probe.SECURITY_HEADERS},
}
PLANNED = {"name": "app-r", "max_instances": 3, "cpu": "1", "memory": "512Mi"}


def all_checks(service=None, probe_result=None, logs=None):
    service = service or live_service()
    probe_result = probe_result or PROBE_OK
    return (
        audit.security_checks(
            service,
            {"bindings": []},
            {"app-r-gemini": True},
            probe_result,
            {"before": 12, "after": 0},
        )
        + audit.reliability_checks(service)
        + audit.cost_checks(service, PLANNED, 4.2)
        + audit.observability_checks(
            service,
            logs if logs is not None else [{"x": 1}],
            {"google_monitoring_alert_policy"},
        )
        + audit.deploy_checks(service, probe_result, IMAGE)
    )


def test_perfect_service_scores_100():
    checks = all_checks()
    assert [c["name"] for c in checks if not c["passed"]] == []
    result = audit.score(checks)
    assert result["total"] == 100
    assert [c["name"] for c in result["categories"]] == list(audit.CATEGORIES)


def test_default_sa_and_plain_secret_fail():
    svc = live_service()
    svc["template"]["serviceAccount"] = (
        "956008489215-compute@developer.gserviceaccount.com"
    )
    svc["template"]["containers"][0]["env"].append(
        {"name": "X", "value": "AIza" + "a" * 35}
    )
    failed = {c["name"] for c in all_checks(service=svc) if not c["passed"]}
    assert failed == {"Runtime service account", "No secrets in plain env vars"}


def test_scoring_math_weights():
    checks = [
        audit.check("a", "Security", True, "", 3),
        audit.check("b", "Security", False, "", 1),
        audit.check("c", "Cost", False, "", 2),
        audit.check("d", "Cost", True, "", 2),
    ]
    result = audit.score(checks, {"Cost": "note"})
    by_name = {c["name"]: c for c in result["categories"]}
    assert by_name["Security"]["value"] == 75
    assert by_name["Cost"]["value"] == 50
    assert by_name["Cost"]["note"] == "note"
    assert by_name["Reliability"]["value"] == 0
    assert result["total"] == round((75 + 50) / 2)


def test_drift_and_uncapped_cost_fail():
    svc = live_service()
    svc["template"]["scaling"] = {"maxInstanceCount": 100, "minInstanceCount": 1}
    failed = {
        c["name"] for c in audit.cost_checks(svc, PLANNED, None) if not c["passed"]
    }
    assert failed == {
        "Cost estimate present",
        "Deployed config matches priced plan",
        "Scales to zero",
    }


def test_cost_total_and_codeguard_counts():
    assert audit.cost_total({"monthly_total_usd": 3.5}) == 3.5
    assert audit.cost_total({"lines": []}) is None
    assert audit.codeguard_counts({"summary": "Fixed. Findings 17 -> 2; 1 left"}) == {
        "before": 17,
        "after": 2,
    }
    assert audit.codeguard_counts(
        {"result": {"before": {"a": 3}, "after": {"a": 0}}}
    ) == {"before": 3, "after": 0}
    assert audit.codeguard_counts({}) == {}


class Handler(BaseHTTPRequestHandler):
    hits = 0

    def do_GET(self):
        Handler.hits += 1
        if self.path == "/" and Handler.hits == 1:
            self.send_response(503)
            self.end_headers()
            return
        if self.path in ("/", "/api/notes"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Powered-By", "Express")
            self.end_headers()
            self.wfile.write(b"<html>ok</html>")
            return
        self.send_response(404)
        self.end_headers()
        self.wfile.write(b"Error: at /app/server.js:12")

    def log_message(self, *args):
        pass


@pytest.fixture
def server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def test_probe_waits_and_records(server):
    Handler.hits = 0
    result = probe.probe(server, "/api/notes", attempts=3, delay=0.05)
    assert result["root"]["status"] == 200
    assert result["api"]["status"] == 200
    assert (
        result["missing"]["status"] == 404 and "server.js" in result["missing"]["body"]
    )
    assert result["http"] is None
    assert result["security_headers"]["x-content-type-options"] is True
    assert result["security_headers"]["strict-transport-security"] is False
    assert result["x_powered_by"] == "Express"
    assert "headers" not in probe.compact(result)["root"]


def test_probe_unreachable():
    result = probe.probe("http://127.0.0.1:9", None, attempts=1, delay=0)
    assert "error" in result["root"]
    checks = audit.deploy_checks(live_service(), result, IMAGE)
    assert not next(c for c in checks if c["name"] == "Home page responds")["passed"]


def test_find_api_path(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.jsx").write_text('axios.get("/api/frontend")')
    (tmp_path / "server.js").write_text(
        'app.get("/api/files/:name", h)\napp.get("/api/notes", h)'
    )
    assert probe.find_api_path(tmp_path) == "/api/notes"
