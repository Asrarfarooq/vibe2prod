import json

import pytest

from deploy import gate, terraform

RUN = "vibed-app-t-deploy"
PROJECT = "vibe2prod-509620"
GOOGLE = "registry.terraform.io/hashicorp/google"


def rc(
    address, rtype, actions, after=None, unknown=None, provider=GOOGLE, mode="managed"
):
    return {
        "address": address,
        "type": rtype,
        "mode": mode,
        "provider_name": provider,
        "change": {
            "actions": actions,
            "after": after or {},
            "after_unknown": unknown or {},
        },
    }


def service(actions=("create",), name=f"app-{RUN}"):
    return rc(
        "google_cloud_run_v2_service.app",
        "google_cloud_run_v2_service",
        list(actions),
        {
            "name": name,
            "project": PROJECT,
            "template": [
                {
                    "scaling": [{"max_instance_count": 3, "min_instance_count": 0}],
                    "containers": [
                        {"resources": [{"limits": {"cpu": "1", "memory": "512Mi"}}]}
                    ],
                }
            ],
        },
    )


def safe_plan():
    return {
        "resource_changes": [
            service(),
            rc(
                "google_project_iam_member.ai",
                "google_project_iam_member",
                ["create"],
                {"role": "roles/aiplatform.user", "project": PROJECT},
                {"member": True},
            ),
            rc(
                "google_storage_bucket_iam_member.obj",
                "google_storage_bucket_iam_member",
                ["create"],
                {
                    "bucket": f"{PROJECT}-app-{RUN}",
                    "role": "roles/storage.objectAdmin",
                    "member": f"serviceAccount:vibe2prod-app-runtime@{PROJECT}.iam.gserviceaccount.com",
                },
            ),
            rc(
                "google_storage_bucket_object.seed",
                "google_storage_bucket_object",
                ["create"],
                {"name": "seed.json", "bucket": f"{PROJECT}-app-{RUN}"},
            ),
            rc(
                "google_firestore_database.db",
                "google_firestore_database",
                ["no-op"],
                {"name": f"app-{RUN}"},
            ),
            rc(
                "random_id.suffix",
                "random_id",
                ["create"],
                provider="registry.terraform.io/hashicorp/random",
            ),
            rc("data.google_project.p", "google_project", ["read"], mode="data"),
        ]
    }


def test_safe_plan_passes():
    assert gate.violations(safe_plan(), RUN, PROJECT) == []


def test_observability_resources():
    metric = rc(
        "google_logging_metric.errors",
        "google_logging_metric",
        ["create"],
        {"name": f"app-{RUN}-errors", "project": PROJECT},
    )
    alert = rc(
        "google_monitoring_alert_policy.errors",
        "google_monitoring_alert_policy",
        ["create"],
        {"display_name": f"app-{RUN} 5xx responses", "project": PROJECT},
        {"name": True},
    )
    plan = safe_plan()
    plan["resource_changes"] += [metric, alert]
    assert gate.violations(plan, RUN, PROJECT) == []
    metric["change"]["after"]["name"] = "errors"
    assert gate.violations(plan, RUN, PROJECT) == [
        f"google_logging_metric.errors: name='errors' lacks the app-{RUN} prefix"
    ]


@pytest.mark.parametrize(
    "actions",
    [["delete"], ["delete", "create"], ["create", "delete"], ["forget"]],
)
def test_delete_and_replace_rejected(actions):
    plan = {"resource_changes": [service(actions)]}
    found = gate.violations(plan, RUN, PROJECT)
    assert len(found) == 1 and "not allowed" in found[0]


def test_update_allowed():
    assert (
        gate.violations({"resource_changes": [service(["update"])]}, RUN, PROJECT) == []
    )


def test_foreign_name_rejected():
    for name in ("vibe2prod-dashboard", "hello-agent", "(default)", "app-other-run"):
        found = gate.violations(
            {"resource_changes": [service(name=name)]}, RUN, PROJECT
        )
        assert found and "lacks the" in found[0], name


def test_platform_secret_and_bucket_rejected():
    plan = {
        "resource_changes": [
            rc(
                "google_secret_manager_secret.s",
                "google_secret_manager_secret",
                ["create"],
                {"secret_id": "github-agent-token"},
            ),
            rc(
                "google_storage_bucket_iam_member.m",
                "google_storage_bucket_iam_member",
                ["create"],
                {
                    "bucket": "vibe2prod-509620-tfstate",
                    "role": "roles/storage.objectViewer",
                    "member": f"serviceAccount:vibe2prod-app-runtime@{PROJECT}.iam.gserviceaccount.com",
                },
            ),
        ]
    }
    assert len(gate.violations(plan, RUN, PROJECT)) == 2


def test_denied_types_rejected():
    for rtype in (
        "google_project_iam_binding",
        "google_project_iam_policy",
        "google_service_account_key",
        "google_service_account",
        "google_service_account_iam_member",
        "google_project_service",
    ):
        plan = {"resource_changes": [rc(f"{rtype}.x", rtype, ["create"], {})]}
        assert any("not allowed" in v for v in gate.violations(plan, RUN, PROJECT)), (
            rtype
        )


def test_public_and_foreign_members_rejected():
    plan = {
        "resource_changes": [
            rc(
                "google_cloud_run_v2_service_iam_member.pub",
                "google_cloud_run_v2_service_iam_member",
                ["create"],
                {
                    "name": f"app-{RUN}",
                    "role": "roles/run.invoker",
                    "member": "allUsers",
                },
            ),
            rc(
                "google_project_iam_member.x",
                "google_project_iam_member",
                ["create"],
                {"role": "roles/datastore.user", "member": "user:someone@example.com"},
            ),
        ]
    }
    found = gate.violations(plan, RUN, PROJECT)
    assert any("allUsers" in v for v in found) and any(
        "someone@example.com" in v for v in found
    )


def test_broad_roles_rejected():
    plan = {
        "resource_changes": [
            rc(
                "google_project_iam_member.o",
                "google_project_iam_member",
                ["create"],
                {
                    "role": "roles/owner",
                    "member": f"serviceAccount:vibe2prod-app-runtime@{PROJECT}.iam.gserviceaccount.com",
                },
            ),
            rc(
                "google_project_iam_member.a",
                "google_project_iam_member",
                ["create"],
                {
                    "role": "roles/storage.admin",
                    "member": f"serviceAccount:vibe2prod-app-runtime@{PROJECT}.iam.gserviceaccount.com",
                },
            ),
        ]
    }
    assert len(gate.violations(plan, RUN, PROJECT)) == 2


def test_other_project_and_provider_rejected():
    plan = {
        "resource_changes": [
            rc(
                "google_storage_bucket.a",
                "google_storage_bucket",
                ["create"],
                {"name": f"app-{RUN}-x", "project": "other"},
            ),
            rc(
                "aws_s3_bucket.b",
                "aws_s3_bucket",
                ["create"],
                {},
                provider="registry.terraform.io/hashicorp/aws",
            ),
        ]
    }
    found = gate.violations(plan, RUN, PROJECT)
    assert any("project other" in v for v in found) and any(
        "provider" in v for v in found
    )


def test_summary_and_planned_service():
    plan = safe_plan()
    summary = gate.summarize(plan)
    assert summary["counts"] == {"create": 5, "no-op": 1}
    assert gate.planned_service(plan) == {
        "name": f"app-{RUN}",
        "max_instances": 3,
        "min_instances": 0,
        "cpu": "1",
        "memory": "512Mi",
    }


def test_backend_check(tmp_path):
    state = tmp_path / ".terraform" / "terraform.tfstate"
    state.parent.mkdir()
    with pytest.raises(terraform.TerraformError):
        terraform.check_backend(tmp_path, RUN)
    state.write_text(json.dumps({"backend": {"type": "local", "config": {}}}))
    with pytest.raises(terraform.TerraformError):
        terraform.check_backend(tmp_path, RUN)
    state.write_text(
        json.dumps(
            {
                "backend": {
                    "type": "gcs",
                    "config": {
                        "bucket": terraform.STATE_BUCKET,
                        "prefix": f"apps/{RUN}",
                    },
                }
            }
        )
    )
    terraform.check_backend(tmp_path, RUN)
