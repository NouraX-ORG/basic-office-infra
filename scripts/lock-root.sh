#!/usr/bin/env bash
# Second hardening step: turn off root SSH login once "ssh nourax@server" is known to work.
#   sudo bash scripts/lock-root.sh
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
[ -s /home/nourax/.ssh/authorized_keys ] || { echo "nourax has no SSH key - not locking root" >&2; exit 1; }

cat > /etc/ssh/sshd_config.d/01-nourax-root.conf <<'CONF'
PermitRootLogin no
AllowUsers nourax
CONF
sshd -t
systemctl reload ssh
echo "Root SSH login is now off. Only nourax can log in, with its key."
