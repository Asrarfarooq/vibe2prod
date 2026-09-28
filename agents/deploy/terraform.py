import json
import os
import subprocess
from pathlib import Path

STATE_BUCKET = os.environ.get("TF_STATE_BUCKET", "vibe2prod-509620-tfstate")
PLAN_FILE = "tfplan"
# Terraform uses ADC itself. The google provider (7.46.1 verified) never switches to *.mtls hosts,
# so it must get the unbound metadata token its Go client requests, not a cert-bound Python token.
ENV = {"TF_IN_AUTOMATION": "1", "TF_INPUT": "0", "CHECKPOINT_DISABLE": "1"}


class TerraformError(RuntimeError):
    pass


def run(args: list[str], cwd: Path, timeout: int = 1800) -> str:
    proc = subprocess.run(
        ["terraform", *args, "-no-color"],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        env={**os.environ, **ENV},
    )
    output = proc.stdout + proc.stderr
    if proc.returncode != 0:
        raise TerraformError(f"terraform {args[0]} failed: {output[-2000:]}")
    return output


def init(cwd: Path, run_id: str) -> str:
    out = run(
        [
            "init",
            "-input=false",
            f"-backend-config=bucket={STATE_BUCKET}",
            f"-backend-config=prefix=apps/{run_id}",
        ],
        cwd,
        timeout=600,
    )
    check_backend(cwd, run_id)
    return out


def check_backend(cwd: Path, run_id: str) -> None:
    """Refuses local state: a job container is ephemeral, so local state would orphan every resource."""
    state = cwd / ".terraform" / "terraform.tfstate"
    backend = json.loads(state.read_text()).get("backend", {}) if state.exists() else {}
    config = backend.get("config") or {}
    if (
        backend.get("type") != "gcs"
        or config.get("bucket") != STATE_BUCKET
        or config.get("prefix") != f"apps/{run_id}"
    ):
        raise TerraformError(
            f"Terraform backend must be gcs bucket {STATE_BUCKET} prefix apps/{run_id}; "
            f"got {backend.get('type')} {config.get('bucket')} {config.get('prefix')}"
        )


def plan(cwd: Path, variables: dict[str, str]) -> dict:
    args = ["plan", "-input=false", "-lock-timeout=120s", f"-out={PLAN_FILE}"]
    args += [f"-var={k}={v}" for k, v in variables.items()]
    run(args, cwd)
    return json.loads(run(["show", "-json", PLAN_FILE], cwd, timeout=300))


def apply(cwd: Path) -> str:
    return run(
        ["apply", "-input=false", "-lock-timeout=120s", "-auto-approve", PLAN_FILE], cwd
    )


def outputs(cwd: Path) -> dict:
    raw = json.loads(run(["output", "-json"], cwd, timeout=300))
    return {k: v.get("value") for k, v in raw.items()}
