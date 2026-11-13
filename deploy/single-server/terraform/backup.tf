# =============================================================================
# Daily disk snapshots (Amazon Data Lifecycle Manager, DLM)
#
# Target: every EBS volume tagged Backup = "dpdp-daily" — the server's root
# disk (ec2.tf root_block_device tags). That disk holds the OS, the Docker
# volumes (PostgreSQL, evidence, certificates) and the swap file.
#
# Schedule: daily at 20:30 UTC = 02:00 IST (India) = 07:30 AEDT / 06:30 AEST
# (Sydney). DLM starts within one hour of that time.
# Retention: the newest `snapshot_retention_count` (7) snapshots are kept;
# older ones are deleted automatically.
#
# Snapshots are encrypted (the volume is) and incremental: you pay for the
# blocks that changed, at the EBS snapshot storage rate. They are NOT deleted
# when the server or this policy is deleted — remove them by hand if needed.
#
# A crash-consistent disk snapshot is a safety net, not a complete backup:
# also keep logical database dumps and the .env.prod keys off the server
# (README "Backups and recovery").
# =============================================================================

# DLM itself (the service) is allowed to use this role...
data "aws_iam_policy_document" "dlm_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  name               = "${local.name}-snapshots"
  assume_role_policy = data.aws_iam_policy_document.dlm_assume.json
}

# ...and the role carries AWS's managed policy for DLM: create/delete
# snapshots and tag them. Nothing else.
resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "daily" {
  description        = "DPDP server disk daily snapshots" # AWS allows letters, digits, spaces only
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { Backup = local.backup_tag }

    schedule {
      name      = "daily"
      copy_tags = true

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["20:30"] # UTC
      }

      retain_rule {
        count = var.snapshot_retention_count
      }
    }
  }

  depends_on = [aws_iam_role_policy_attachment.dlm]
}
