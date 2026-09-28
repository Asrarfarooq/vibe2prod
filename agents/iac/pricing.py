import math
import os
import re

import google.auth
import google.oauth2.credentials
from google.api_core.client_options import ClientOptions
from google.auth.transport.requests import AuthorizedSession
from google.cloud import billing_v1

CLOUD_RUN = "152E-C115-5142"
FIRESTORE = "EE2C-7FAC-5E08"
STORAGE = "95FF-2EF5-5EA1"
SECRET_MANAGER = "EE82-7A5E-871C"
VERTEX_AI = "C7E2-9256-1C43"
SECONDS_PER_MONTH = 730 * 3600
DAYS_PER_MONTH = 730 / 24
GIB = 1024**3
# Cloud Run CPU and memory free tiers are credits, not catalog tiers (cloud.google.com/run/pricing).
RUN_FREE = {
    "request": {"cpu": 180_000, "memory": 360_000},
    "instance": {"cpu": 240_000, "memory": 450_000},
}
FIRESTORE_LOCATIONS = {"us-central1": "Iowa", "nam5": "North America 5"}
FREE_TYPES = {
    "google_service_account",
    "google_project_iam_member",
    "google_secret_manager_secret",
    "google_secret_manager_secret_iam_member",
    "google_storage_bucket_iam_member",
    "google_cloud_run_v2_service_iam_member",
    "random_password",
    "random_id",
    "random_string",
}
DEFAULT_SECRET_ACCESSES = 1500
PRICING_SA = os.environ.get(
    "PRICING_SA", "vibe2prod-pricing@vibe2prod-509620.iam.gserviceaccount.com"
)
SCOPE = "https://www.googleapis.com/auth/cloud-platform"


def _pricing_credentials():
    """Cloud Billing rejects Agent Identity tokens, so prices are read as a role-less pricing SA."""
    source, _ = google.auth.default(scopes=[SCOPE])
    session = AuthorizedSession(source)
    session.configure_mtls_channel()
    host = (
        "iamcredentials.mtls.googleapis.com"
        if session.is_mtls
        else "iamcredentials.googleapis.com"
    )
    resp = session.post(
        f"https://{host}/v1/projects/-/serviceAccounts/{PRICING_SA}:generateAccessToken",
        json={"scope": [SCOPE], "lifetime": "3600s"},
        timeout=30,
    )
    resp.raise_for_status()
    return google.oauth2.credentials.Credentials(resp.json()["accessToken"])


class Catalog:
    """Live public list prices from the Cloud Billing Catalog API; no billing role is needed."""

    def __init__(self):
        self._client = billing_v1.CloudCatalogClient(
            credentials=_pricing_credentials(),
            client_options=ClientOptions(api_endpoint="cloudbilling.googleapis.com"),
        )
        self._skus: dict[str, list] = {}

    def _list(self, service: str) -> list:
        if service not in self._skus:
            self._skus[service] = list(
                self._client.list_skus(
                    request={"parent": f"services/{service}", "currency_code": "USD"}
                )
            )
        return self._skus[service]

    def find(self, service: str, pattern: str, region: str | None = None):
        """Exactly one SKU whose description fully matches pattern, preferring the region's SKU."""
        matches = [
            s
            for s in self._list(service)
            if re.fullmatch(pattern, s.description)
            and s.category.usage_type == "OnDemand"
        ]
        if region:
            regional = [s for s in matches if region in s.service_regions]
            matches = regional or [s for s in matches if "global" in s.service_regions]
        if len(matches) != 1:
            found = ", ".join(f"{s.sku_id} {s.description}" for s in matches) or "none"
            raise LookupError(
                f"SKU {pattern!r} in {region}: expected 1 match, found {found}"
            )
        return matches[0]


def _price(rate) -> float:
    return rate.unit_price.units + rate.unit_price.nanos / 1e9


def tiered_cost(sku, quantity: float) -> float:
    """Applies the SKU's tiered rates; free tiers appear as $0 first tiers. Daily tiers are applied per day."""
    info = sku.pricing_info[0]
    rates = sorted(
        info.pricing_expression.tiered_rates, key=lambda r: r.start_usage_amount
    )
    daily = (
        info.aggregation_info.aggregation_interval
        == billing_v1.AggregationInfo.AggregationInterval.DAILY
    )
    qty = quantity / DAYS_PER_MONTH if daily else quantity
    total = 0.0
    for i, rate in enumerate(rates):
        start = rate.start_usage_amount
        end = rates[i + 1].start_usage_amount if i + 1 < len(rates) else math.inf
        if qty > start:
            total += (min(qty, end) - start) * _price(rate)
    return total * DAYS_PER_MONTH if daily else total


def _item(resource: str, sku, quantity: float, monthly: float) -> dict:
    rates = sku.pricing_info[0].pricing_expression.tiered_rates
    return {
        "resource": resource,
        "sku": f"{sku.sku_id} {sku.description}",
        "sku_id": sku.sku_id,
        "unit": sku.pricing_info[0].pricing_expression.usage_unit_description,
        "unit_price": max((_price(r) for r in rates), default=0.0),
        "quantity": round(quantity, 4),
        "monthly": round(monthly, 4),
    }


def _cpu(value) -> float:
    value = str(value or "1")
    return float(value[:-1]) / 1000 if value.endswith("m") else float(value)


def _gib(value) -> float:
    value = str(value or "512Mi")
    units = {"Ki": 2**10, "Mi": 2**20, "Gi": 2**30, "K": 1e3, "M": 1e6, "G": 1e9}
    for suffix, factor in units.items():
        if value.endswith(suffix):
            return float(value[: -len(suffix)]) * factor / GIB
    return float(value) / GIB


def _first(value) -> dict:
    return value[0] if isinstance(value, list) and value else {}


class Estimator:
    def __init__(self, catalog: Catalog, usage: dict, region: str):
        self.catalog = catalog
        self.region = region
        self.u = usage
        self.items: list[dict] = []
        self.assumptions: list[str] = []
        self.has_bucket = False

    def num(self, key: str, default: float = 0) -> float:
        value = self.u.get(key)
        return float(value) if isinstance(value, (int, float)) else float(default)

    def add(
        self, resource: str, service: str, pattern: str, quantity: float, region=None
    ):
        sku = self.catalog.find(service, pattern, region)
        self.items.append(_item(resource, sku, quantity, tiered_cost(sku, quantity)))
        return sku

    def cloud_run(self, addr: str, after: dict) -> None:
        tmpl = _first(after.get("template"))
        container = _first(tmpl.get("containers"))
        res = _first(container.get("resources"))
        limits = res.get("limits") or {}
        cpu, mem = _cpu(limits.get("cpu")), _gib(limits.get("memory"))
        min_instances = int(
            _first(tmpl.get("scaling")).get("min_instance_count")
            or _first(after.get("scaling")).get("min_instance_count")
            or 0
        )
        request_based = res.get("cpu_idle") is not False
        requests = self.num("monthly_requests")
        seconds = self.num("avg_request_seconds")
        busy = requests * seconds
        mode = "request" if request_based else "instance"
        self.assumptions.append(
            f"Cloud Run {addr}: {cpu:g} vCPU, {mem:g} GiB, {mode}-based billing, min instances {min_instances}; "
            f"{requests:,.0f} requests/month x {seconds:g} s, billed as if requests never overlap (upper bound)."
        )
        free = RUN_FREE[mode]
        if request_based:
            cpu_s = max(0.0, cpu * busy - free["cpu"])
            mem_s = max(0.0, mem * busy - free["memory"])
            self.add(
                addr,
                CLOUD_RUN,
                r"Services CPU \(Request-based billing\)",
                cpu_s,
                self.region,
            )
            self.add(
                addr,
                CLOUD_RUN,
                r"Services Memory \(Request-based billing\)",
                mem_s,
                self.region,
            )
            self.add(addr, CLOUD_RUN, r"Requests", requests)
            if min_instances:
                idle = max(0.0, min_instances * SECONDS_PER_MONTH - busy)
                self.add(
                    addr,
                    CLOUD_RUN,
                    r"Services Min Instance CPU \(Request-based billing\)",
                    cpu * idle,
                    self.region,
                )
                self.add(
                    addr,
                    CLOUD_RUN,
                    r"Services Min Instance Memory \(Request-based billing\)",
                    mem * idle,
                    self.region,
                )
        else:
            alive = max(busy, min_instances * SECONDS_PER_MONTH)
            region = re.escape(self.region)
            self.add(
                addr,
                CLOUD_RUN,
                rf"Services CPU \(Instance-based billing\) in {region}",
                max(0.0, cpu * alive - free["cpu"]),
                self.region,
            )
            self.add(
                addr,
                CLOUD_RUN,
                rf"Services Memory \(Instance-based billing\) in {region}",
                max(0.0, mem * alive - free["memory"]),
                self.region,
            )
        self.assumptions.append(
            f"Cloud Run free tier applied: {free['cpu']:,} vCPU-seconds and {free['memory']:,} GiB-seconds per billing account per month."
        )
        egress = requests * self.num("avg_response_kb") * 1024 / GIB
        self.add(
            addr,
            CLOUD_RUN,
            r"Cloud Run Network Internet Data Transfer Out North America to North America",
            egress,
            self.region,
        )
        self.assumptions.append(
            f"Internet egress {egress:.2f} GiB/month ({self.num('avg_response_kb'):g} KB per response), users in North America."
        )

    def firestore(self, addr: str, after: dict) -> None:
        location = after.get("location_id") or self.region
        place = FIRESTORE_LOCATIONS.get(location)
        if not place:
            raise LookupError(f"No Firestore price mapping for location {location}")
        reads, writes = self.num("firestore_reads"), self.num("firestore_writes")
        storage = self.num(
            "firestore_storage_gb", self.num("storage_gb") if not self.has_bucket else 0
        )
        self.add(addr, FIRESTORE, rf"Cloud Firestore Read Ops {place}", reads)
        self.add(addr, FIRESTORE, rf"Cloud Firestore Entity Writes {place}", writes)
        self.add(addr, FIRESTORE, rf"Cloud Firestore Storage {place}", storage)
        self.assumptions.append(
            f"Firestore {addr} ({location}): {reads:,.0f} reads, {writes:,.0f} writes per month, {storage:g} GiB stored. "
            "A named database gets no free tier (the project's free tier goes to its first database)."
        )

    def bucket(self, addr: str, after: dict) -> None:
        location = (after.get("location") or self.region).lower()
        storage_class = (after.get("storage_class") or "STANDARD").upper()
        if storage_class != "STANDARD":
            raise LookupError(
                f"No Cloud Storage price mapping for class {storage_class}"
            )
        gb = self.num("gcs_storage_gb", self.num("storage_gb"))
        class_a, class_b = self.num("gcs_class_a_ops"), self.num("gcs_class_b_ops")
        self.add(addr, STORAGE, r"Standard Storage [\w ]+ Regional", gb, location)
        self.add(addr, STORAGE, r"Regional Standard Class A Operations", class_a)
        self.add(addr, STORAGE, r"Regional Standard Class B Operations", class_b)
        self.assumptions.append(
            f"Cloud Storage {addr} ({location}, STANDARD): {gb:g} GiB stored, {class_a:,.0f} Class A and "
            f"{class_b:,.0f} Class B operations per month; free tiers are per billing account."
        )

    def secrets(self, versions: list[str]) -> None:
        if not versions:
            return
        accesses = self.num("secret_accesses", DEFAULT_SECRET_ACCESSES * len(versions))
        self.add(
            ", ".join(versions),
            SECRET_MANAGER,
            r"Secret version replica storage",
            len(versions),
        )
        self.add(
            ", ".join(versions), SECRET_MANAGER, r"Secret access operations", accesses
        )
        self.assumptions.append(
            f"Secret Manager: {len(versions)} active version(s), one replica location each (automatic replication); "
            f"{accesses:,.0f} accesses/month (secrets are read at instance start, about two starts per hour)."
        )

    def gemini(self) -> None:
        calls = self.num("gemini_calls_per_month")
        if not calls:
            return
        model = str(self.u.get("gemini_model") or "gemini-3.8-flash")
        label = " ".join(
            p.capitalize() if not p[0].isdigit() else p for p in model.split("-")
        )
        tokens_in = calls * self.num("avg_input_tokens")
        tokens_out = calls * self.num("avg_output_tokens")
        resource = f"{model} on Vertex AI (location global)"
        try:
            self.add(
                resource,
                VERTEX_AI,
                rf"{re.escape(label)} Global Text Input - Predictions",
                tokens_in,
            )
            self.add(
                resource,
                VERTEX_AI,
                rf"{re.escape(label)} Global Text Output - Predictions",
                tokens_out,
            )
        except LookupError as err:
            self.assumptions.append(f"Gemini not priced: {err}")
            return
        self.assumptions.append(
            f"Gemini: {calls:,.0f} calls/month, {self.num('avg_input_tokens'):,.0f} input and "
            f"{self.num('avg_output_tokens'):,.0f} output tokens per call (output includes thinking tokens), "
            "standard on-demand catalog price; introductory promotions are not applied."
        )


def estimate(
    plan: dict, usage: dict, region: str, catalog: Catalog | None = None
) -> dict:
    """Prices a Terraform plan's creates with live list prices and the design's usage assumptions."""
    est = Estimator(catalog or Catalog(), usage or {}, region)
    creates = [
        rc
        for rc in plan.get("resource_changes", [])
        if rc.get("mode") == "managed" and "create" in rc["change"]["actions"]
    ]
    est.has_bucket = any(rc["type"] == "google_storage_bucket" for rc in creates)
    versions, unpriced = [], []
    for rc in creates:
        addr, rtype, after = rc["address"], rc["type"], rc["change"].get("after") or {}
        if rtype == "google_cloud_run_v2_service":
            est.cloud_run(addr, after)
        elif rtype == "google_firestore_database":
            est.firestore(addr, after)
        elif rtype == "google_storage_bucket":
            est.bucket(addr, after)
        elif rtype == "google_secret_manager_secret_version":
            versions.append(addr)
        elif rtype not in FREE_TYPES:
            unpriced.append(addr)
    est.secrets(versions)
    est.gemini()
    free = sorted({rc["type"] for rc in creates if rc["type"] in FREE_TYPES})
    if free:
        est.assumptions.append(f"No charge: {', '.join(free)}.")
    if unpriced:
        est.assumptions.append(f"Not priced (no mapping): {', '.join(unpriced)}.")
    est.assumptions += [
        "Container image storage is in the shared Artifact Registry repository and is not included.",
        "Cloud Logging and Monitoring stay within the free allotments at this volume (50 GiB logs per project per month).",
        (
            "Public list prices in USD from the Cloud Billing Catalog API; taxes, support and discounts are not included. "
            "Verify any SKU at https://cloud.google.com/skus/?filter=<SKU_ID>."
        ),
    ]
    return {
        "currency": "USD",
        "monthly_total": round(sum(i["monthly"] for i in est.items), 2),
        "items": est.items,
        "assumptions": est.assumptions,
    }
