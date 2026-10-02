import posixpath
import re
import subprocess
from datetime import datetime
from pathlib import Path

MARKER = "v2p-scorecard"
STAGE_ORDER = ("codeguard", "architect", "iac", "deploy")
SERVICES = {
    "google_cloud_run_v2_service": "Cloud Run",
    "google_firestore_database": "Firestore",
    "google_storage_bucket": "Cloud Storage",
    "google_secret_manager_secret": "Secret Manager",
    "google_sql_database_instance": "Cloud SQL",
    "google_redis_instance": "Memorystore",
    "google_pubsub_topic": "Pub/Sub",
    "google_logging_metric": "Cloud Logging metric",
    "google_monitoring_alert_policy": "Cloud Monitoring alert",
}
INSTRUCTION = re.compile(r"^\s*(FROM|USER)\s+(.+?)\s*$", re.IGNORECASE | re.MULTILINE)


def _git(workdir: Path, *args: str) -> str | None:
    proc = subprocess.run(
        ["git", *args],
        cwd=workdir,
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    return proc.stdout if proc.returncode == 0 else None


def repo_facts(workdir: Path, ref: str | None, app_path: str) -> dict | None:
    """Dockerfile text and Terraform file count of the app at a git ref, or None if the ref is unknown."""
    if not ref:
        return None
    prefix = posixpath.normpath(app_path or ".")
    listing = _git(workdir, "ls-tree", "-r", "--name-only", ref, "--", prefix)
    if listing is None:
        return None
    return {
        "dockerfile": _git(
            workdir, "show", f"{ref}:{posixpath.join(prefix, 'Dockerfile')}"
        ),
        "tf_files": sum(1 for f in listing.splitlines() if f.endswith(".tf")),
    }


def container(dockerfile: str | None) -> dict | None:
    """Base image and user of the final build stage; a stage without USER runs as root."""
    if dockerfile is None:
        return None
    base, user = None, None
    for kind, value in INSTRUCTION.findall(dockerfile):
        if kind.upper() == "FROM":
            base = next((t for t in value.split() if not t.startswith("--")), None)
            user = None
        else:
            user = value
    non_root = bool(user) and user.split(":")[0] not in ("root", "0")
    return {"base": base, "user": user, "non_root": non_root}


def _container_text(facts: dict) -> str:
    who = f"non-root user {facts['user']}" if facts["non_root"] else "root"
    return f"{facts['base']}, runs as {who}"


def _count_delta(before: int, after: int) -> str:
    diff = after - before
    if not before:
        return f"{diff:+d}"
    return f"{diff:+d} ({round(100 * diff / before):+d}%)"


def _row(category: str, before: str, after: str, delta: str, improved: bool) -> dict:
    return {
        "category": category,
        "before": before,
        "after": after,
        "delta": delta,
        "improved": bool(improved),
    }


def _resource_types(plan_summary: dict) -> list[str]:
    return [a.split(".")[-2] for a in plan_summary.get("resources") or [] if "." in a]


def _minutes(stages: dict, now: datetime) -> int | None:
    total = 0.0
    for key in STAGE_ORDER:
        stage = stages.get(key) or {}
        start = stage.get("started_at")
        end = stage.get("ended_at") or (now if key == "deploy" else None)
        if not isinstance(start, datetime) or not isinstance(end, datetime):
            return None
        total += (end - start).total_seconds()
    return round(total / 60)


def build(
    run_doc: dict,
    checks: list[dict],
    score: dict,
    before: dict | None,
    after: dict | None,
    now: datetime,
) -> dict:
    """Before/after rows from data the run recorded; rows without data on both sides are left out."""
    stages = run_doc.get("stages") or {}
    cg = (stages.get("codeguard") or {}).get("result") or {}
    iac = (stages.get("iac") or {}).get("result") or {}
    plan = iac.get("plan_summary") or {}
    types = _resource_types(plan)
    rows = []

    if isinstance(cg.get("before"), dict) and isinstance(cg.get("after"), dict):
        b, a = sum(cg["before"].values()), sum(cg["after"].values())
        rows.append(
            _row("Security findings", str(b), str(a), _count_delta(b, a), a < b)
        )
        for scanner, label in (
            ("gitleaks", "Hardcoded secret findings"),
            ("osv-scanner", "Dependency vulnerabilities"),
        ):
            if scanner in cg["before"]:
                b, a = cg["before"][scanner], cg["after"].get(scanner, 0)
                after_text = str(a)
                if scanner == "gitleaks":
                    after_text += f"; {types.count('google_secret_manager_secret')} in Secret Manager"
                rows.append(_row(label, str(b), after_text, _count_delta(b, a), a < b))

    old = container((before or {}).get("dockerfile"))
    new = container((after or {}).get("dockerfile"))
    if old and new:
        hardened = new["non_root"] and not old["non_root"]
        rows.append(
            _row(
                "Container",
                _container_text(old),
                _container_text(new),
                "Non-root"
                if hardened
                else ("Unchanged" if old == new else "Base image changed"),
                hardened,
            )
        )

    no_infra = before is not None and not before["tf_files"]
    if before is None:
        infra_before = "Not compared"
    elif no_infra:
        infra_before = "None"
    else:
        infra_before = f"{before['tf_files']} Terraform files"
    services = list(dict.fromkeys(SERVICES[t] for t in types if t in SERVICES))
    if services:
        rows.append(
            _row(
                "Cloud architecture",
                "No cloud resources defined" if no_infra else infra_before,
                ", ".join(services),
                f"+{len(services)} services",
                no_infra,
            )
        )
    if isinstance(plan.get("add"), int):
        backend = iac.get("backend") or {}
        rows.append(
            _row(
                "Infrastructure as code",
                infra_before,
                f"{plan['add']} Terraform resources"
                + (", remote state in GCS" if backend.get("bucket") else ""),
                f"+{plan['add']} resources",
                plan["add"] > 0,
            )
        )

    cost = (iac.get("cost") or {}).get("monthly_total")
    if isinstance(cost, (int, float)):
        rows.append(
            _row(
                "Monthly cost",
                "Not estimated",
                f"${cost:.2f}/month estimated",
                "Estimated",
                True,
            )
        )

    passed = sum(1 for c in checks if c["passed"])
    rows.append(
        _row(
            "Readiness score",
            "Not scored",
            f"{score['total']}/100 ({passed}/{len(checks)} checks passed)",
            "First audit",
            True,
        )
    )
    return {"rows": rows, "agent_minutes": _minutes(stages, now), "generated_at": now}


def _cell(text: str) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def markdown(card: dict) -> str:
    lines = [
        "## Before vs after",
        "",
        "| Category | Before (vibe-coded) | After (Vibe2Prod) | Change |",
        "|---|---|---|---|",
    ]
    lines += [
        f"| {_cell(r['category'])} | {_cell(r['before'])} | {_cell(r['after'])} | {_cell(r['delta'])} |"
        for r in card["rows"]
    ]
    footer = "Computed by the Vibe2Prod Deploy agent from this run's scanner results, Terraform plan and readiness audit."
    if card.get("agent_minutes") is not None:
        footer = (
            f"Agent time across the four stages: {card['agent_minutes']} min. {footer}"
        )
    return "\n".join([*lines, "", footer])
