# Input variables. Set your own values in terraform.tfvars
# (copy terraform.tfvars.example). Two have NO default and must be set:
# ssh_allowed_cidr (your IP) — Terraform asks for it if it is missing.

# --- Where ------------------------------------------------------------------------

variable "aws_region" {
  description = "AWS region for every resource. Asia Pacific (Sydney) = ap-southeast-2."
  type        = string
  default     = "ap-southeast-2"
}

variable "availability_zone" {
  description = "Availability Zone for the server (and its disk). Must be in aws_region and offer instance_type — checked at plan time."
  type        = string
  default     = "ap-southeast-2a"
}

variable "project" {
  description = "Short name used in resource names and tags."
  type        = string
  default     = "dpdp"
}

# --- Server size --------------------------------------------------------------------

variable "instance_type" {
  description = "EC2 size. Must be x86_64 (the Docker images are amd64) with at least 2 GiB RAM — checked at plan time. See README 'Cost and server size'."
  type        = string
  default     = "t3a.small"
}

variable "root_volume_gb" {
  description = "Disk size in GB (OS, Docker images, PostgreSQL data, swap file). Can be increased later without rebuilding the server; can NEVER be decreased."
  type        = number
  default     = 20

  validation {
    condition     = var.root_volume_gb >= 16
    error_message = "root_volume_gb must be at least 16 GB (OS + Docker images + 2 GB swap + database)."
  }
}

# --- Access -------------------------------------------------------------------------

variable "ssh_public_key_path" {
  description = "Path to your SSH PUBLIC key (.pub). Only this file is read and uploaded; the private key is never read. ~ expands to your home folder (C:\\Users\\<you> on Windows)."
  type        = string
  default     = "~/.ssh/dpdp_key.pub"

  validation {
    condition     = endswith(var.ssh_public_key_path, ".pub")
    error_message = "ssh_public_key_path must point to the PUBLIC key (a file ending in .pub), never the private key."
  }
}

variable "ssh_allowed_cidr" {
  description = "The ONLY address allowed to use SSH: your public IPv4 address followed by /32, e.g. \"203.0.113.7/32\". No default on purpose."
  type        = string

  validation {
    condition     = can(cidrhost(var.ssh_allowed_cidr, 0)) && endswith(var.ssh_allowed_cidr, "/32")
    error_message = "ssh_allowed_cidr must be a single IPv4 address with /32, e.g. \"203.0.113.7/32\" (get yours from https://checkip.amazonaws.com)."
  }
}

# --- DNS ----------------------------------------------------------------------------

variable "domain_name" {
  description = "Domain whose DNS is hosted in Route 53. Its registrar (Namecheap) must point at that zone's nameservers."
  type        = string
  default     = "hhgoa.work"
}

variable "existing_hosted_zone_id" {
  description = "Leave empty to CREATE the Route 53 zone. If a public zone for domain_name already exists in this account, put its ID here (e.g. \"Z0123456789ABCDEFGHIJ\") so Terraform uses it instead of creating a duplicate. README step 2 shows how to check."
  type        = string
  default     = ""
}

variable "frontend_subdomain" {
  description = "Web app address: <frontend_subdomain>.<domain_name>."
  type        = string
  default     = "app"
}

variable "api_subdomain" {
  description = "API address (also the Gateway's workspace URL): <api_subdomain>.<domain_name>."
  type        = string
  default     = "api"
}

# --- Backups ------------------------------------------------------------------------

variable "snapshot_retention_count" {
  description = "How many daily disk snapshots to keep (one per day, so 7 = one week)."
  type        = number
  default     = 7
}
