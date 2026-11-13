# =============================================================================
# DNS (Route 53)
#
# Either CREATES the public hosted zone for the domain (default), or — when
# existing_hosted_zone_id is set — USES a zone that already exists, so a
# second zone with different nameservers is never created by accident.
# (README step 2 shows how to check for an existing zone.)
#
# Terraform never touches Namecheap: after apply, the zone's 4 nameservers
# (output: route53_nameservers) are entered in Namecheap by hand.
#
# The created zone is protected (prevent_destroy): destroying and re-creating
# it would give it NEW nameservers and break the domain until Namecheap is
# updated again.
# =============================================================================

locals {
  create_zone = var.existing_hosted_zone_id == ""
  zone_id     = local.create_zone ? aws_route53_zone.main[0].zone_id : data.aws_route53_zone.existing[0].zone_id
  nameservers = local.create_zone ? aws_route53_zone.main[0].name_servers : data.aws_route53_zone.existing[0].name_servers
}

resource "aws_route53_zone" "main" {
  count   = local.create_zone ? 1 : 0
  name    = var.domain_name
  comment = "DPDP production - managed by Terraform"

  lifecycle {
    prevent_destroy = true
  }
}

# Earlier versions of this file had a single, un-counted zone resource.
moved {
  from = aws_route53_zone.main
  to   = aws_route53_zone.main[0]
}

data "aws_route53_zone" "existing" {
  count        = local.create_zone ? 0 : 1
  zone_id      = var.existing_hosted_zone_id
  private_zone = false

  lifecycle {
    postcondition {
      condition     = trimsuffix(self.name, ".") == var.domain_name
      error_message = "existing_hosted_zone_id belongs to a different domain than domain_name."
    }
  }
}

# app.<domain> and api.<domain> -> the server's Elastic IP. If either record
# already exists in an adopted zone, apply stops with "already exists" rather
# than overwriting it.
resource "aws_route53_record" "app" {
  zone_id = local.zone_id
  name    = local.app_host
  type    = "A"
  ttl     = 300
  records = [aws_eip.server.public_ip]
}

resource "aws_route53_record" "api" {
  zone_id = local.zone_id
  name    = local.api_host
  type    = "A"
  ttl     = 300
  records = [aws_eip.server.public_ip]
}
