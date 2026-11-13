# =============================================================================
# DPDP Platform — single-server production deployment
# Region: Asia Pacific (Sydney), ap-southeast-2 (variable aws_region)
#
# What this creates:
#   network.tf  a firewall (security group) in the account's DEFAULT VPC
#   ec2.tf      one Ubuntu 24.04 server (Docker installed on first boot by
#               user-data.sh) and a fixed public IP (Elastic IP)
#   dns.tf      the Route 53 zone for the domain (or uses an existing one),
#               and the app./api. records
#   backup.tf   a daily snapshot of the server's disk, last 7 kept
#
# Everything else — API, worker, frontend, PostgreSQL, Caddy (HTTPS) — runs on
# the server from docker-compose.prod.yml. Runbook: ../README.md.
#
# SAFETY: the server and the DNS zone are protected against accidental
# destruction/replacement (prevent_destroy, termination protection). See
# ../README.md "Removing everything" for the deliberate procedure.
# =============================================================================

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.70, < 7.0"
    }
  }

  # STATE: a LOCAL file, terraform.tfstate, in this folder (git-ignored).
  # It contains no passwords or keys for this configuration, but Terraform
  # needs it to change or remove what it created: back it up after every
  # apply (README "Terraform state").
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}

# --- Look-ups (read-only) ------------------------------------------------------------

# The VPC every AWS account has by default in each region; its subnets are
# public, which a single internet-facing server needs. Plan fails clearly if
# the account has no default VPC in this region.
data "aws_vpc" "default" {
  default = true
}

# The default VPC's subnet in the chosen Availability Zone.
data "aws_subnet" "server" {
  vpc_id            = data.aws_vpc.default.id
  availability_zone = var.availability_zone
  default_for_az    = true
}

# Which Availability Zones in this region offer the chosen instance type.
data "aws_ec2_instance_type_offerings" "server" {
  location_type = "availability-zone"

  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
}

# Facts about the chosen instance type (architecture, memory).
data "aws_ec2_instance_type" "server" {
  instance_type = var.instance_type
}

# The newest official Ubuntu 24.04 LTS (amd64, gp3) image from Canonical.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "state"
    values = ["available"]
  }
}

locals {
  name     = "${var.project}-server"
  app_host = "${var.frontend_subdomain}.${var.domain_name}"
  api_host = "${var.api_subdomain}.${var.domain_name}"

  # Volumes carrying this tag are snapshotted daily (backup.tf).
  backup_tag = "${var.project}-daily"

  # Path of the PRIVATE key, derived from the public key path — used only to
  # print the ssh command. Terraform never reads it.
  ssh_private_key_path = trimsuffix(pathexpand(var.ssh_public_key_path), ".pub")
}
