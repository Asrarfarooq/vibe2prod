terraform {
  required_version = "~> 1.16"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.1"
    }
  }

  backend "gcs" {
    bucket = "vibe2prod-509620-tfstate"
    prefix = "apps/lalitha-app-1"
  }
}

provider "google" {
  project = local.project
  region  = local.region

  default_labels = {
    v2p-run = local.run_label
  }
}

locals {
  project    = "vibe2prod-509620"
  region     = "us-central1"
  name       = "app-lalitha-app-1"
  runtime_sa = "vibe2prod-app-runtime@vibe2prod-509620.iam.gserviceaccount.com"
  run_label  = "lalitha-app-1"
}
