#!/usr/bin/env bash
# First-boot hardening for a fresh Ubuntu 24.04 server. Run once, as root:
#   sudo bash bootstrap-server.sh <owner-ip> [repo-url]
# It installs Docker, creates the admin user "nourax" (SSH key only), firewalls everything
# except SSH from the owner's IP, turns on automatic security updates and adds swap.
# Root login is switched off by a separate step (lock-root.sh) after the new user is tested.
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

OWNER_IP="${1:?usage: bootstrap-server.sh <owner-ip> [repo-url]}"
REPO_URL="${2:-https://github.com/NouraX-ORG/basic-office-infra.git}"
ADMIN_USER=nourax
INSTALL_DIR=/opt/nourax/basic-office-infra

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
. /etc/os-release
[ "${VERSION_ID:-}" = "24.04" ] || { echo "expected Ubuntu 24.04, found ${PRETTY_NAME:-unknown}" >&2; exit 1; }
[[ "$OWNER_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "owner IP must be an IPv4 address" >&2; exit 1; }
# Providers differ: Hetzner puts the key on root, OVHcloud on the "ubuntu" user (run with sudo).
KEY_FILE=/root/.ssh/authorized_keys
if [ ! -s "$KEY_FILE" ] && [ -n "${SUDO_USER:-}" ]; then KEY_FILE="/home/$SUDO_USER/.ssh/authorized_keys"; fi
[ -s "$KEY_FILE" ] || { echo "no SSH key found for root or the sudo user - refusing to continue" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
APT_OPTS=(-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

echo "== packages"
apt-get update -q
apt-get "${APT_OPTS[@]}" full-upgrade
apt-get "${APT_OPTS[@]}" install ca-certificates curl gnupg ufw unattended-upgrades git jq rclone age zstd

echo "== docker (official repository)"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
	> /etc/apt/sources.list.d/docker.list
apt-get update -q
apt-get "${APT_OPTS[@]}" install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
cat > /etc/docker/daemon.json <<'JSON'
{
  "live-restore": true,
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
systemctl restart docker

echo "== admin user $ADMIN_USER (key login only)"
if ! id "$ADMIN_USER" >/dev/null 2>&1; then
	adduser --disabled-password --gecos "" "$ADMIN_USER"
fi
usermod -aG sudo,docker "$ADMIN_USER"
install -d -m 0700 -o "$ADMIN_USER" -g "$ADMIN_USER" "/home/$ADMIN_USER/.ssh"
install -m 0600 -o "$ADMIN_USER" -g "$ADMIN_USER" "$KEY_FILE" "/home/$ADMIN_USER/.ssh/authorized_keys"
echo "$ADMIN_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-nourax
chmod 0440 /etc/sudoers.d/90-nourax
visudo -cq

echo "== sshd: keys only"
cat > /etc/ssh/sshd_config.d/00-nourax.conf <<'CONF'
# Nourax hardening (first match wins, so this file is read before cloud-init's).
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
CONF
sshd -t
systemctl reload ssh

echo "== firewall: nothing inbound except SSH from $OWNER_IP"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow from "$OWNER_IP" to any port 22 proto tcp comment 'owner SSH'
ufw --force enable
ufw status verbose

echo "== automatic security updates (reboot at 04:30 if needed)"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
cat > /etc/apt/apt.conf.d/52nourax-unattended-upgrades <<'CONF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
CONF
systemctl enable --now unattended-upgrades

echo "== swap (4 GiB) and time zone"
if ! swapon --show | grep -q /swapfile; then
	fallocate -l 4G /swapfile
	chmod 600 /swapfile
	mkswap /swapfile >/dev/null
	swapon /swapfile
	grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10 >/dev/null
echo 'vm.swappiness=10' > /etc/sysctl.d/90-nourax.conf
timedatectl set-timezone Europe/London

echo "== folders and repo"
install -d -m 0700 -o root -g root /etc/nourax /etc/nourax/secrets
install -d -m 0755 /opt/nourax
if [ ! -d "$INSTALL_DIR/.git" ]; then
	git clone "$REPO_URL" "$INSTALL_DIR"
fi
chown -R "$ADMIN_USER:$ADMIN_USER" "$INSTALL_DIR"

echo "== CPU check (ONLYOFFICE needs a modern x86-64 CPU)"
grep -m1 'model name' /proc/cpuinfo || true
for flag in sse4_2 avx avx2; do
	if grep -qw "$flag" /proc/cpuinfo; then echo "  $flag: yes"; else echo "  $flag: NO"; fi
done
free -h

echo "BOOTSTRAP DONE. Test: ssh $ADMIN_USER@<server-ip> 'sudo true && docker ps' - then run lock-root.sh"
