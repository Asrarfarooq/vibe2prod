import re
from collections import Counter

ALLOWED_ACTIONS = ({"no-op"}, {"create"}, {"read"}, {"update"})
ALLOWED_PROVIDERS = {
    "registry.terraform.io/hashicorp/google",
    "registry.terraform.io/hashicorp/google-beta",
    "registry.terraform.io/hashicorp/random",
}
# Authoritative IAM, projects, keys and org/billing scope can take over or wipe platform access.
DENIED_TYPE = re.compile(
    r"(_iam_policy|_iam_binding)$"
    r"|^google_(project|project_service|project_iam_custom_role|service_account|service_account_key)$"
    r"|^google_service_account_iam_"
    r"|^google_(organization|folder|billing|org_policy|access_context_manager)_"
)
NAME_FIELDS = (
    "name",
    "account_id",
    "secret_id",
    "service",
    "bucket",
    "service_account_id",
    "database",
)
SKIP_NAME_FIELDS = {"google_storage_bucket_object": {"name"}}
PUBLIC_MEMBERS = {"allUsers", "allAuthenticatedUsers"}
BASIC_ROLES = {"roles/owner", "roles/editor", "roles/viewer"}
RUNTIME_SA_ID = "vibe2prod-app-runtime"


class PlanRejected(RuntimeError):
    pass


def _last_segment(value: str) -> str:
    return value.rstrip("/").rsplit("/", 1)[-1]


def violations(plan: dict, run_id: str, project: str) -> list[str]:
    """Returns every reason the plan must not be applied; empty means the plan is safe."""
    prefix = f"app-{run_id}"
    runtime_member = f"serviceAccount:{RUNTIME_SA_ID}@{project}.iam.gserviceaccount.com"
    found = []
    for rc in plan.get("resource_changes", []):
        if rc.get("mode") != "managed":
            continue
        address, rtype = rc["address"], rc["type"]
        change = rc.get("change", {})
        actions = set(change.get("actions", []))
        if actions not in ALLOWED_ACTIONS:
            found.append(
                f"{address}: action {'/'.join(change.get('actions', []))} is not allowed (only create, update, no-op)"
            )
            continue
        if rc.get("provider_name") not in ALLOWED_PROVIDERS:
            found.append(
                f"{address}: provider {rc.get('provider_name')} is not allowed"
            )
        if DENIED_TYPE.search(rtype):
            found.append(
                f"{address}: resource type {rtype} is not allowed for app deployments"
            )
        if actions == {"no-op"} or rtype.startswith("random_"):
            continue
        after = change.get("after") or {}
        unknown = change.get("after_unknown") or {}
        if isinstance(after.get("project"), str) and after["project"] not in (
            project,
            f"projects/{project}",
        ):
            found.append(f"{address}: project {after['project']} is not {project}")
        for field in NAME_FIELDS:
            if (
                field in SKIP_NAME_FIELDS.get(rtype, set())
                or unknown.get(field) is True
            ):
                continue
            value = after.get(field)
            if isinstance(value, str) and value and prefix not in _last_segment(value):
                found.append(f"{address}: {field}={value!r} lacks the {prefix} prefix")
        members = after.get("members") or (
            [after["member"]] if isinstance(after.get("member"), str) else []
        )
        for member in members:
            if member in PUBLIC_MEMBERS:
                found.append(f"{address}: grants to {member} are not allowed")
            elif member != runtime_member:
                found.append(
                    f"{address}: member {member!r} is not the app's own identity"
                )
        role = after.get("role")
        if isinstance(role, str) and (
            role in BASIC_ROLES
            or (rtype == "google_project_iam_member" and "admin" in role.lower())
        ):
            found.append(f"{address}: role {role} is too broad")
    return found


def summarize(plan: dict) -> dict:
    counts = Counter()
    resources = []
    for rc in plan.get("resource_changes", []):
        if rc.get("mode") != "managed":
            continue
        action = "/".join(rc.get("change", {}).get("actions", []))
        counts[action] += 1
        if action != "no-op":
            resources.append({"address": rc["address"], "action": action})
    return {"counts": dict(counts), "resources": resources}


def planned_service(plan: dict) -> dict:
    """The Cloud Run service values from the plan, used to detect drift from what was priced."""
    for rc in plan.get("resource_changes", []):
        if (
            rc.get("type") == "google_cloud_run_v2_service"
            and rc.get("mode") == "managed"
        ):
            after = rc.get("change", {}).get("after") or {}
            template = (after.get("template") or [{}])[0]
            scaling = (template.get("scaling") or [{}])[0]
            container = (template.get("containers") or [{}])[0]
            limits = ((container.get("resources") or [{}])[0] or {}).get("limits") or {}
            return {
                "name": after.get("name"),
                "max_instances": scaling.get("max_instance_count"),
                "min_instances": scaling.get("min_instance_count"),
                "cpu": limits.get("cpu"),
                "memory": limits.get("memory"),
            }
    return {}
