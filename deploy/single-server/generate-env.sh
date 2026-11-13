#!/usr/bin/env bash
# =============================================================================
# Creates .env.prod — every secret the production stack needs, freshly
# generated — in the repository root (or at the path given as $1).
#
#   bash deploy/single-server/generate-env.sh
#
# Run it ONCE, on the server. It refuses to overwrite an existing file: that
# file holds the keys that decrypt data already in the database, and losing or
# replacing them makes that data unreadable. Back it up somewhere safe.
#
# Nothing is printed except the file name.
# =============================================================================
set -euo pipefail

APP_DOMAIN="${APP_DOMAIN:-app.hhgoa.work}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:-$REPO_ROOT/.env.prod}"

if [ -e "$OUT" ]; then
  echo "$OUT already exists — not overwriting it (it holds your encryption keys)." >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "openssl is required (sudo apt-get install -y openssl)." >&2; exit 1; }

# Hex: letters and digits only, so safe inside a connection URL.
hex() { openssl rand -hex "$1"; }
ADMIN_PASSWORD="$(hex 24)"
OWNER_PASSWORD="$(hex 24)"
APP_PASSWORD="$(hex 24)"

umask 077 # the file is readable by its owner only
cat > "$OUT" <<EOF
# DPDP production environment — generated $(date -u +%Y-%m-%dT%H:%MZ).
# SECRET. Never commit, never share, back it up somewhere safe.
NODE_ENV=production

# --- PostgreSQL container (admin account: db-bootstrap and backups only) -------
POSTGRES_USER=dpdp_admin
POSTGRES_PASSWORD=${ADMIN_PASSWORD}
POSTGRES_DB=dpdp

# --- db-bootstrap (creates the application roles with these passwords) ---------
DB_HOST=postgres
DB_PORT=5432
DB_NAME=dpdp
DB_ADMIN_USER=dpdp_admin
DB_ADMIN_PASSWORD=${ADMIN_PASSWORD}
DPDP_OWNER_PASSWORD=${OWNER_PASSWORD}
DPDP_APP_PASSWORD=${APP_PASSWORD}

# --- Application -------------------------------------------------------------
# Runtime role, row-level security enforced.
APP_DATABASE_URL=postgresql://dpdp_app:${APP_PASSWORD}@postgres:5432/dpdp
# Schema owner: migrations and the job queue.
DATABASE_URL=postgresql://dpdp_owner:${OWNER_PASSWORD}@postgres:5432/dpdp

JWT_SECRET=$(hex 32)
REQUEST_OTP_SECRET=$(hex 32)
# AES-256 keys (32 bytes). Replacing them makes existing encrypted data unreadable.
MFA_SECRET_ENC_KEY=$(openssl rand -base64 32)
SUBMISSION_STAGING_ENC_KEY=$(openssl rand -base64 32)

API_PORT=3001
WEB_ORIGIN=https://${APP_DOMAIN}
# One proxy (Caddy) in front of the API.
TRUST_PROXY=1
DB_POOL_MAX=10
MFA_ISSUER=DPDP Platform

# Import evidence on this server's disk (the "evidence" volume).
IMPORT_EVIDENCE_STORE=local

# E-mail / SMS. Without real providers, messages (including portal one-time
# codes) are only logged, redacted, and reach nobody. Fill in to enable:
NOTIFY_TRANSPORT=console
# POSTMARK_API_KEY=
# POSTMARK_FROM_EMAIL=
# MSG91_AUTH_KEY=
# MSG91_SENDER_ID=
EOF

chmod 600 "$OUT"
echo "Wrote $OUT (mode 600: readable by you only). Back it up off the server now."
