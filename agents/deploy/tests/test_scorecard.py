import subprocess
from datetime import datetime, timedelta, timezone

from deploy import scorecard

T0 = datetime(2026, 9, 28, 20, 0, tzinfo=timezone.utc)
CHECKS = [
    {"name": "a", "category": "Security", "passed": True, "detail": ""},
    {"name": "b", "category": "Cost", "passed": False, "detail": ""},
]
SCORE = {"total": 95, "categories": []}
BEFORE_DOCKERFILE = "FROM node:latest\nWORKDIR /app\nCOPY . .\nCMD npm start\n"
AFTER_DOCKERFILE = "FROM node:24-slim\nWORKDIR /app\nUSER 1000:1000\nCMD npm start\n"


def stage(minutes_in: int, minutes: int, result: dict | None = None) -> dict:
    start = T0 + timedelta(minutes=minutes_in)
    return {
        "started_at": start,
        "ended_at": start + timedelta(minutes=minutes),
        "result": result or {},
    }


def run_doc() -> dict:
    return {
        "stages": {
            "codeguard": stage(
                0,
                18,
                {
                    "before": {
                        "osv-scanner": 12,
                        "hadolint": 3,
                        "semgrep": 6,
                        "gitleaks": 2,
                    },
                    "after": {
                        "osv-scanner": 0,
                        "hadolint": 0,
                        "semgrep": 0,
                        "gitleaks": 0,
                    },
                },
            ),
            "architect": stage(20, 10),
            "iac": stage(
                40,
                6,
                {
                    "plan_summary": {
                        "add": 4,
                        "resources": [
                            "google_cloud_run_v2_service.service",
                            "google_secret_manager_secret.admin_token",
                            "google_secret_manager_secret_version.admin_token",
                            "google_firestore_database.database",
                        ],
                    },
                    "cost": {"monthly_total": 1.476},
                    "backend": {"bucket": "b", "prefix": "apps/r"},
                },
            ),
            "deploy": {"started_at": T0 + timedelta(minutes=50)},
        }
    }


def rows_by_category(card: dict) -> dict:
    return {r["category"]: r for r in card["rows"]}


def test_container_without_user_runs_as_root():
    assert scorecard.container(BEFORE_DOCKERFILE) == {
        "base": "node:latest",
        "user": None,
        "non_root": False,
    }


def test_container_uses_final_stage_only():
    text = (
        "FROM --platform=linux/amd64 node:24 AS build\nUSER node\nFROM node:24-slim\n"
    )
    assert scorecard.container(text) == {
        "base": "node:24-slim",
        "user": None,
        "non_root": False,
    }


def test_container_root_user_is_not_hardened():
    assert not scorecard.container("FROM node\nUSER root:root\n")["non_root"]
    assert not scorecard.container("FROM node\nUSER 0\n")["non_root"]
    assert scorecard.container(AFTER_DOCKERFILE)["non_root"]
    assert scorecard.container(None) is None


def test_build_full_run():
    card = scorecard.build(
        run_doc(),
        CHECKS,
        SCORE,
        {"dockerfile": BEFORE_DOCKERFILE, "tf_files": 0},
        {"dockerfile": AFTER_DOCKERFILE, "tf_files": 4},
        T0 + timedelta(minutes=55),
    )
    rows = rows_by_category(card)
    assert list(rows) == [
        "Security findings",
        "Hardcoded secret findings",
        "Dependency vulnerabilities",
        "Container",
        "Cloud architecture",
        "Infrastructure as code",
        "Monthly cost",
        "Readiness score",
    ]
    assert rows["Security findings"] == {
        "category": "Security findings",
        "before": "23",
        "after": "0",
        "delta": "-23 (-100%)",
        "improved": True,
    }
    assert rows["Hardcoded secret findings"]["after"] == "0; 1 in Secret Manager"
    assert rows["Container"]["before"] == "node:latest, runs as root"
    assert rows["Container"]["after"] == "node:24-slim, runs as non-root user 1000:1000"
    assert rows["Container"]["delta"] == "Non-root"
    assert rows["Cloud architecture"]["after"] == "Cloud Run, Secret Manager, Firestore"
    assert rows["Cloud architecture"]["before"] == "No cloud resources defined"
    assert rows["Infrastructure as code"]["before"] == "None"
    assert (
        rows["Infrastructure as code"]["after"]
        == "4 Terraform resources, remote state in GCS"
    )
    assert rows["Monthly cost"]["after"] == "$1.48/month estimated"
    assert rows["Readiness score"]["before"] == "Not scored"
    assert rows["Readiness score"]["after"] == "95/100 (1/2 checks passed)"
    assert card["agent_minutes"] == 18 + 10 + 6 + 5
    assert card["generated_at"] == T0 + timedelta(minutes=55)


def test_build_leaves_out_rows_without_data():
    card = scorecard.build({"stages": {}}, CHECKS, SCORE, None, None, T0)
    assert [r["category"] for r in card["rows"]] == ["Readiness score"]
    assert card["agent_minutes"] is None


def test_unchanged_findings_are_not_improved():
    doc = {
        "stages": {
            "codeguard": {"result": {"before": {"semgrep": 5}, "after": {"semgrep": 5}}}
        }
    }
    row = scorecard.build(doc, CHECKS, SCORE, None, None, T0)["rows"][0]
    assert row["delta"] == "+0 (+0%)"
    assert row["improved"] is False


def test_markdown_table_is_ascii_and_escaped():
    card = {
        "rows": [scorecard._row("A|B", "x", "y", "Added", True)],
        "agent_minutes": 39,
    }
    text = scorecard.markdown(card)
    assert "| A\\|B | x | y | Added |" in text
    assert "Agent time across the four stages: 39 min." in text
    assert text.isascii()


def test_repo_facts_reads_git_ref(tmp_path):
    def git(*args):
        subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True)

    git("init", "-q")
    (tmp_path / "app" / "infra").mkdir(parents=True)
    (tmp_path / "app" / "Dockerfile").write_text(BEFORE_DOCKERFILE)
    git("add", ".")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base")
    (tmp_path / "app" / "infra" / "main.tf").write_text("")
    (tmp_path / "app" / "Dockerfile").write_text(AFTER_DOCKERFILE)
    git("add", ".")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "after")

    assert scorecard.repo_facts(tmp_path, "HEAD~1", "app") == {
        "dockerfile": BEFORE_DOCKERFILE,
        "tf_files": 0,
    }
    assert scorecard.repo_facts(tmp_path, "HEAD", "app")["tf_files"] == 1
    assert scorecard.repo_facts(tmp_path, "deadbeef", "app") is None
    assert scorecard.repo_facts(tmp_path, None, "app") is None
