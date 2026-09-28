import re

CATEGORIES = ("Security", "Reliability", "Cost", "Observability", "Deploy health")
SECRET_NAME = re.compile(
    r"(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)", re.IGNORECASE
)
SECRET_VALUE = re.compile(
    r"(AIza[0-9A-Za-z_\-]{30,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}"
    r"|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abpr]-[A-Za-z0-9-]{10,})"
)
DEFAULT_SA = re.compile(
    r"(-compute@developer\.gserviceaccount\.com|@appspot\.gserviceaccount\.com)$"
)
MAX_COLD_START_MS = 8000
MAX_INSTANCES_CAP = 100


def check(name: str, category: str, passed: bool, detail: str, weight: int = 1) -> dict:
    return {
        "name": name,
        "category": category,
        "passed": bool(passed),
        "detail": detail,
        "weight": weight,
    }


def _container(service: dict) -> dict:
    return ((service.get("template") or {}).get("containers") or [{}])[0]


def _scaling(service: dict) -> dict:
    return {
        **(service.get("scaling") or {}),
        **((service.get("template") or {}).get("scaling") or {}),
    }


def security_checks(
    service: dict,
    iam: dict,
    secrets_found: dict[str, bool],
    probe: dict,
    codeguard: dict,
) -> list[dict]:
    sa = (service.get("template") or {}).get("serviceAccount") or ""
    env = _container(service).get("env") or []
    plain = [e for e in env if "value" in e]
    leaked = [
        e["name"]
        for e in plain
        if SECRET_NAME.search(e["name"]) or SECRET_VALUE.search(e.get("value") or "")
    ]
    refs = [e for e in env if (e.get("valueSource") or {}).get("secretKeyRef")]
    missing = [name for name, ok in secrets_found.items() if not ok]
    public = [
        m
        for b in iam.get("bindings", [])
        for m in b.get("members", [])
        if m in ("allUsers", "allAuthenticatedUsers")
    ]
    headers = probe.get("security_headers") or {}
    present = [h for h, ok in headers.items() if ok]
    http = probe.get("http") or {}
    after = codeguard.get("after")
    return [
        check(
            "Runtime service account",
            "Security",
            sa and not DEFAULT_SA.search(sa),
            f"Runs as {sa or 'the default compute service account'}",
            3,
        ),
        check(
            "No secrets in plain env vars",
            "Security",
            not leaked,
            f"Secret-looking plain env vars: {', '.join(leaked)}"
            if leaked
            else f"{len(plain)} plain env vars, none secret-looking",
            3,
        ),
        check(
            "Secrets from Secret Manager",
            "Security",
            not missing,
            f"Missing secrets: {', '.join(missing)}"
            if missing
            else f"{len(refs)} env vars read from Secret Manager, all secrets exist",
            2,
        ),
        check(
            "No allUsers IAM binding",
            "Security",
            not public,
            "Public access uses invoker_iam_disabled, no allUsers binding"
            if not public
            else f"Service IAM grants {', '.join(public)}",
            2,
        ),
        check(
            "Security headers",
            "Security",
            len(present) >= 3,
            f"{len(present)}/{len(headers)} present: {', '.join(present) or 'none'}",
            2,
        ),
        check(
            "HTTPS only",
            "Security",
            (probe.get("root") or {}).get("url", "").startswith("https://")
            and (
                not http
                or http.get("status") in (301, 302, 307, 308)
                or http.get("error")
            ),
            f"HTTP request returned {http.get('status') or http.get('error') or 'n/a'}",
        ),
        check(
            "CodeGuard findings resolved",
            "Security",
            after == 0,
            f"Scanner findings {codeguard['before']} -> {after}"
            if after is not None
            else "No CodeGuard scanner counts recorded for this run",
            2,
        ),
    ]


def reliability_checks(service: dict) -> list[dict]:
    container = _container(service)
    limits = (container.get("resources") or {}).get("limits") or {}
    return [
        check(
            "Startup or liveness probe",
            "Reliability",
            bool(container.get("startupProbe") or container.get("livenessProbe")),
            "Configured"
            if container.get("startupProbe") or container.get("livenessProbe")
            else "No probe configured",
        ),
        check(
            "CPU and memory limits",
            "Reliability",
            bool(limits.get("cpu") and limits.get("memory")),
            f"cpu={limits.get('cpu')}, memory={limits.get('memory')}",
        ),
        check(
            "Request timeout set",
            "Reliability",
            bool((service.get("template") or {}).get("timeout")),
            f"timeout={(service.get('template') or {}).get('timeout')}",
        ),
        check(
            "Latest revision serving",
            "Reliability",
            service.get("latestReadyRevision")
            and service.get("latestReadyRevision")
            == service.get("latestCreatedRevision"),
            f"latest ready {str(service.get('latestReadyRevision', '')).rsplit('/', 1)[-1]}",
            2,
        ),
    ]


def cost_checks(service: dict, planned: dict, estimate: float | None) -> list[dict]:
    scaling = _scaling(service)
    limits = (_container(service).get("resources") or {}).get("limits") or {}
    max_i = scaling.get("maxInstanceCount")
    live = {
        "max_instances": max_i,
        "min_instances": scaling.get("minInstanceCount", 0),
        "cpu": limits.get("cpu"),
        "memory": limits.get("memory"),
    }
    drift = [
        k
        for k in ("max_instances", "cpu", "memory")
        if planned.get(k) is not None and str(planned[k]) != str(live[k])
    ]
    return [
        check(
            "Cost estimate present",
            "Cost",
            estimate is not None,
            f"IaC estimate {estimate:.2f} USD/month"
            if estimate is not None
            else "No estimate from the IaC stage",
        ),
        check(
            "Deployed config matches priced plan",
            "Cost",
            not drift,
            f"Drift in {', '.join(drift)}"
            if drift
            else f"max={live['max_instances']}, cpu={live['cpu']}, memory={live['memory']}",
            2,
        ),
        check(
            "Max instances capped",
            "Cost",
            isinstance(max_i, int) and 0 < max_i <= MAX_INSTANCES_CAP,
            f"maxInstanceCount={max_i}",
            2,
        ),
        check(
            "Scales to zero",
            "Cost",
            not live["min_instances"],
            f"minInstanceCount={live['min_instances']}",
        ),
    ]


def observability_checks(
    service: dict, log_entries: list[dict], plan_types: set[str]
) -> list[dict]:
    labels = service.get("labels") or {}
    monitoring = sorted(
        t for t in plan_types if t.startswith(("google_monitoring_", "google_logging_"))
    )
    return [
        check(
            "Request logs in Cloud Logging",
            "Observability",
            bool(log_entries),
            f"{len(log_entries)} recent log entries after the probes"
            if log_entries
            else "No log entries found",
            2,
        ),
        check(
            "Run label on service",
            "Observability",
            "v2p-run" in labels,
            f"labels: {', '.join(f'{k}={v}' for k, v in labels.items()) or 'none'}",
        ),
        check(
            "Alerting or log metrics",
            "Observability",
            bool(monitoring),
            ", ".join(monitoring)
            or "No monitoring or log-metric resources in Terraform",
        ),
    ]


def deploy_checks(service: dict, probe: dict, image: str) -> list[dict]:
    root = probe.get("root") or {}
    api = probe.get("api")
    cond = service.get("terminalCondition") or {}
    live_image = _container(service).get("image", "")
    cold = probe.get("cold_start_ms")
    checks = [
        check(
            "Service ready",
            "Deploy health",
            cond.get("state") == "CONDITION_SUCCEEDED",
            f"{cond.get('type', 'Ready')}: {cond.get('state')} {cond.get('message', '')}".strip(),
            3,
        ),
        check(
            "Home page responds",
            "Deploy health",
            root.get("status") == 200,
            f"GET / -> {root.get('status') or root.get('error')}",
            3,
        ),
        check(
            "Deployed image is the built image",
            "Deploy health",
            live_image == image,
            live_image or "no image",
            2,
        ),
        check(
            "Cold start latency",
            "Deploy health",
            cold is not None and cold <= MAX_COLD_START_MS,
            f"first request {cold} ms (limit {MAX_COLD_START_MS} ms)",
        ),
    ]
    if api is not None:
        checks.append(
            check(
                "API responds",
                "Deploy health",
                isinstance(api.get("status"), int) and api["status"] < 500,
                f"GET {api['url'].split('/', 3)[-1]} -> {api.get('status') or api.get('error')}",
                2,
            )
        )
    return checks


def score(checks: list[dict], notes: dict[str, str] | None = None) -> dict:
    """Weighted pass rate per category; total is the mean of measured categories."""
    notes = notes or {}
    categories = []
    for name in CATEGORIES:
        items = [c for c in checks if c["category"] == name]
        total_w = sum(c.get("weight", 1) for c in items)
        value = (
            round(100 * sum(c.get("weight", 1) for c in items if c["passed"]) / total_w)
            if total_w
            else 0
        )
        passed = sum(1 for c in items if c["passed"])
        categories.append(
            {
                "name": name,
                "value": value,
                "note": notes.get(name) or f"{passed}/{len(items)} checks passed",
            }
        )
    measured = [
        c["value"]
        for c, n in zip(categories, CATEGORIES)
        if any(k["category"] == n for k in checks)
    ]
    return {
        "total": round(sum(measured) / len(measured)) if measured else 0,
        "categories": categories,
    }


def cost_total(cost: dict | None) -> float | None:
    """Monthly USD total from the IaC stage's cost result, whichever key it uses."""
    if not isinstance(cost, dict):
        return None
    for key in (
        "monthly_total_usd",
        "total_monthly_usd",
        "monthly_usd",
        "monthly_total",
        "total_usd",
        "total",
    ):
        value = cost.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return None


def codeguard_counts(stage: dict) -> dict:
    """Before/after scanner counts from the CodeGuard result, or parsed from its summary."""
    result = stage.get("result") or {}
    if isinstance(result.get("after"), dict):
        return {
            "before": sum(result.get("before", {}).values()),
            "after": sum(result["after"].values()),
        }
    match = re.search(r"Findings (\d+) -> (\d+)", stage.get("summary") or "")
    return (
        {"before": int(match.group(1)), "after": int(match.group(2))} if match else {}
    )
