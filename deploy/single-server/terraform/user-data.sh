#!/bin/bash
# =============================================================================
# First-boot setup for the DPDP server (Ubuntu 24.04). Runs once, as root,
# via cloud-init. Progress: /var/log/cloud-init-output.log
#
#   1. a 2 GB swap file (building the images needs more than 4 GB RAM at peak)
#   2. Docker Engine + the Compose and Buildx plugins, from Docker's official
#      apt repository (https://docs.docker.com/engine/install/ubuntu/)
#   3. lets the "ubuntu" user run docker without sudo
# =============================================================================
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# --- 1. Swap ------------------------------------------------------------------
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- 2. Docker ----------------------------------------------------------------
apt-get update
apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# --- 3. Docker for the ubuntu user --------------------------------------------
usermod -aG docker ubuntu

echo "DPDP server setup finished" > /var/log/dpdp-setup-done
