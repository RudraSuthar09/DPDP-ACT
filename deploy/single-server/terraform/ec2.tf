# =============================================================================
# The server
#
# Ubuntu 24.04, Docker installed on first boot by user-data.sh. All
# application data (PostgreSQL, import evidence, TLS certificates) lives on
# this instance's disk, which is snapshotted daily (backup.tf).
#
# PROTECTION — the database lives on this server, so:
#   - prevent_destroy: Terraform refuses any plan that would destroy or
#     REPLACE it (the plan fails instead of deleting data);
#   - disable_api_termination: the AWS console/CLI refuse to terminate it;
#   - ignore_changes: a newer Ubuntu image, an edit to user-data.sh, or a new
#     SSH key never trigger a replacement.
# Changing instance_type or root_volume_gb (bigger) is done IN PLACE: AWS
# stops the server, applies the change and starts it again (a few minutes of
# downtime, no data loss).
# =============================================================================

# Your SSH PUBLIC key, so you can log in as "ubuntu". Only the .pub file is
# read (the variable refuses anything else).
resource "aws_key_pair" "server" {
  key_name   = "${local.name}-ssh"
  public_key = trimspace(file(pathexpand(var.ssh_public_key_path)))

  lifecycle {
    precondition {
      condition     = can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) ", trimspace(file(pathexpand(var.ssh_public_key_path)))))
      error_message = "ssh_public_key_path does not contain an OpenSSH public key (it should start with ssh-ed25519, ssh-rsa or ecdsa-sha2-...)."
    }
  }
}

resource "aws_instance" "server" {
  ami                     = data.aws_ami.ubuntu.id
  instance_type           = var.instance_type
  subnet_id               = data.aws_subnet.server.id
  key_name                = aws_key_pair.server.key_name
  vpc_security_group_ids  = [aws_security_group.server.id]
  disable_api_termination = true

  # Runs once, on first boot. Line endings are normalised in case the file
  # was edited on Windows (bash cannot run CRLF scripts).
  user_data = replace(file("${path.module}/user-data.sh"), "\r\n", "\n")

  # "standard" credits: when the CPU is busy for a long time the server slows
  # down instead of adding "unlimited mode" charges to the bill.
  credit_specification {
    cpu_credits = "standard"
  }

  # IMDSv2 only; hop limit 1 also keeps Docker containers away from the
  # instance metadata service.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_size           = var.root_volume_gb
    volume_type           = "gp3"
    encrypted             = true # AWS-managed key; snapshots are encrypted too
    delete_on_termination = true # snapshots (backup.tf) outlive the volume
  }

  # Tags for the disk, applied when it is created (in the same RunInstances
  # call). Backup = selects it for the daily snapshots (backup.tf). Project =
  # what the deployer IAM policy uses to allow resizing/re-tagging exactly
  # this disk (iam/terraform-deployer-ec2-policy.json). Provider default_tags do
  # not reach volume_tags, so Project is set explicitly.
  volume_tags = {
    Name      = "${local.name}-disk"
    Backup    = local.backup_tag
    Project   = var.project
    ManagedBy = "terraform"
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [ami, user_data, key_name]

    precondition {
      condition     = contains(data.aws_ec2_instance_type_offerings.server.locations, var.availability_zone)
      error_message = "instance_type is not offered in availability_zone. Choose another zone (e.g. ap-southeast-2b) or instance type."
    }
    precondition {
      condition     = contains(data.aws_ec2_instance_type.server.supported_architectures, "x86_64")
      error_message = "instance_type must support x86_64: the Docker images are built for linux/amd64 (no Graviton/ARM)."
    }
    precondition {
      condition     = data.aws_ec2_instance_type.server.memory_size >= 2048
      error_message = "instance_type needs at least 2 GiB of RAM for this stack (see README 'Cost and server size')."
    }
  }

  tags = { Name = local.name }
}

# A fixed public IP address, so DNS keeps pointing at the server across
# stops/starts. Billed per hour like any public IPv4 address.
resource "aws_eip" "server" {
  domain   = "vpc"
  instance = aws_instance.server.id
  tags     = { Name = "${local.name}-ip" }
}
