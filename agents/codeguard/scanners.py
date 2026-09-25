import json
import subprocess
import tempfile
from pathlib import Path

SEMGREP_CONFIGS = ["p/javascript", "p/nodejsscan", "p/react", "p/dockerfile"]
SKIP_DIRS = {"node_modules", "dist", ".git"}
TIMEOUT = 600


def _run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, timeout=TIMEOUT, check=False
    )


def _finding(tool, rule, severity, file, line, message) -> dict:
    return {
        "tool": tool,
        "rule": str(rule),
        "severity": str(severity).upper(),
        "file": str(file),
        "line": int(line or 0),
        "message": str(message)[:300],
    }


def gitleaks(root: Path) -> list[dict]:
    with tempfile.NamedTemporaryFile(suffix=".json") as report:
        proc = _run(
            [
                "gitleaks",
                "dir",
                str(root),
                "--report-format",
                "json",
                "--report-path",
                report.name,
                "--no-banner",
                "--exit-code",
                "0",
            ],
            root,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"gitleaks failed: {proc.stderr[-300:]}")
        data = json.loads(Path(report.name).read_text() or "[]")
    return [
        _finding(
            "gitleaks",
            f["RuleID"],
            "HIGH",
            Path(f["File"]).resolve().relative_to(root),
            f.get("StartLine"),
            f"{f.get('Description', 'Secret')} (value redacted)",
        )
        for f in data
    ]


def semgrep(root: Path) -> list[dict]:
    cmd = ["semgrep", "scan", "--json", "--quiet", "--metrics=off"]
    for config in SEMGREP_CONFIGS:
        cmd += ["--config", config]
    proc = _run([*cmd, "."], root)
    if proc.returncode not in (0, 1):
        raise RuntimeError(f"semgrep failed: {proc.stderr[-300:]}")
    data = json.loads(proc.stdout)
    return [
        _finding(
            "semgrep",
            r["check_id"].rsplit(".", 1)[-1],
            r["extra"].get("severity", "WARNING"),
            r["path"],
            r["start"]["line"],
            r["extra"].get("message", ""),
        )
        for r in data.get("results", [])
    ]


def osv(root: Path) -> list[dict]:
    proc = _run(["osv-scanner", "scan", "source", "-r", "--format", "json", "."], root)
    # 0 = clean, 1 = vulnerabilities found, 128 = no packages found.
    if proc.returncode == 128:
        return []
    if proc.returncode not in (0, 1):
        raise RuntimeError(f"osv-scanner failed: {proc.stderr[-300:]}")
    data = json.loads(proc.stdout or "{}")
    findings = []
    for result in data.get("results", []):
        source = Path(result["source"]["path"]).name
        for pkg in result.get("packages", []):
            name = pkg["package"]["name"]
            version = pkg["package"]["version"]
            ids = [v["id"] for v in pkg.get("vulnerabilities", [])]
            severity = max(
                (g.get("max_severity") or "0" for g in pkg.get("groups", [])),
                default="0",
            )
            findings.append(
                _finding(
                    "osv-scanner",
                    f"{name}@{version}",
                    _cvss_label(severity),
                    source,
                    0,
                    f"{len(ids)} known vulnerabilities: {', '.join(ids[:5])}",
                )
            )
    return findings


def _cvss_label(score: str) -> str:
    try:
        value = float(score)
    except ValueError:
        return "MEDIUM"
    if value >= 9:
        return "CRITICAL"
    if value >= 7:
        return "HIGH"
    if value >= 4:
        return "MEDIUM"
    return "LOW"


def hadolint(root: Path) -> list[dict]:
    findings = []
    for dockerfile in root.rglob("Dockerfile*"):
        if SKIP_DIRS.intersection(dockerfile.relative_to(root).parts):
            continue
        proc = _run(["hadolint", "--format", "json", str(dockerfile)], root)
        if proc.returncode not in (0, 1):
            raise RuntimeError(f"hadolint failed: {proc.stderr[-300:]}")
        for r in json.loads(proc.stdout or "[]"):
            findings.append(
                _finding(
                    "hadolint",
                    r["code"],
                    r["level"],
                    dockerfile.relative_to(root),
                    r["line"],
                    r["message"],
                )
            )
    return findings


SCANNERS = {
    "gitleaks": gitleaks,
    "semgrep": semgrep,
    "osv-scanner": osv,
    "hadolint": hadolint,
}


def scan_all(root: Path) -> dict[str, list[dict]]:
    return {name: fn(root) for name, fn in SCANNERS.items()}
