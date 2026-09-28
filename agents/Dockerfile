FROM python:3.12-slim

ARG GITLEAKS_VERSION=8.30.1
ARG OSV_SCANNER_VERSION=2.6.0
ARG HADOLINT_VERSION=2.15.1
ARG SEMGREP_VERSION=1.178.0
ARG TERRAFORM_VERSION=1.16.4

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git nodejs npm unzip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/bin
RUN curl -fsSLO https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz \
 && curl -fsSLO https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_checksums.txt \
 && grep " gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz$" gitleaks_${GITLEAKS_VERSION}_checksums.txt | sha256sum -c - \
 && tar -xzf gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz gitleaks \
 && install -m 0755 gitleaks /usr/local/bin/gitleaks \
 && curl -fsSLO https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_amd64 \
 && curl -fsSLO https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_SHA256SUMS \
 && grep " osv-scanner_linux_amd64$" osv-scanner_SHA256SUMS | sha256sum -c - \
 && install -m 0755 osv-scanner_linux_amd64 /usr/local/bin/osv-scanner \
 && curl -fsSLO https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/hadolint-linux-x86_64 \
 && curl -fsSLO https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/checksums.sha256 \
 && grep "[ *]hadolint-linux-x86_64$" checksums.sha256 | sha256sum -c - \
 && install -m 0755 hadolint-linux-x86_64 /usr/local/bin/hadolint \
 && curl -fsSLO https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip \
 && curl -fsSLO https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_SHA256SUMS \
 && grep " terraform_${TERRAFORM_VERSION}_linux_amd64.zip$" terraform_${TERRAFORM_VERSION}_SHA256SUMS | sha256sum -c - \
 && unzip -q terraform_${TERRAFORM_VERSION}_linux_amd64.zip terraform \
 && install -m 0755 terraform /usr/local/bin/terraform \
 && rm -rf /tmp/bin

# Pre-fetched providers keep terraform init fast and independent of the registry at run time.
ENV TF_PLUGIN_CACHE_DIR=/opt/tf-plugin-cache
RUN mkdir -p /opt/tf-plugin-cache /tmp/tfinit \
 && printf 'terraform {\n  required_providers {\n    google = { source = "hashicorp/google", version = "8.4.0" }\n    random = { source = "hashicorp/random", version = "3.9.1" }\n  }\n}\n' > /tmp/tfinit/main.tf \
 && terraform -chdir=/tmp/tfinit init -backend=false -input=false \
 && rm -rf /tmp/tfinit

# semgrep pins an OpenTelemetry version that conflicts with google-adk, so it gets its own venv.
RUN python -m venv /opt/semgrep \
 && /opt/semgrep/bin/pip install semgrep==${SEMGREP_VERSION} \
 && ln -s /opt/semgrep/bin/semgrep /usr/local/bin/semgrep

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .
RUN useradd --system --uid 10001 --create-home agent
USER agent

CMD ["python", "main.py"]
