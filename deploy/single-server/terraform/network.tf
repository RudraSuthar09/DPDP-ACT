# =============================================================================
# Firewall for the server
#
#   22  SSH    — ONLY from your own IP address (variable ssh_allowed_cidr, /32)
#   80  HTTP   — Caddy: Let's Encrypt validation + redirect to HTTPS
#   443 HTTPS  — Caddy: app.<domain> and api.<domain>
#
# Nothing else is reachable from the internet: the API (3001), frontend
# (3000), PostgreSQL (5432), the Docker daemon and Caddy's admin API are only
# inside the server / its internal Docker network.
# =============================================================================

resource "aws_security_group" "server" {
  name        = "${local.name}-sg"
  description = "DPDP server: SSH from admin IP, HTTP and HTTPS from anywhere"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH from the administrator only"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ssh_allowed_cidr]
  }

  ingress {
    description = "HTTP: certificate validation and redirect to HTTPS"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS over HTTP/3 (QUIC)"
    from_port   = 443
    to_port     = 443
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Outbound: updates, image pulls, certificates, e-mail/SMS providers"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-sg" }
}
