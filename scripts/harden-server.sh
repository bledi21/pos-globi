#!/usr/bin/env bash
# Sigurimi bazë i serverit Ubuntu LTS. Ekzekutohet një herë si root, PASI të keni hyrë me çelës SSH.
# Përdorim: sudo ./scripts/harden-server.sh <përdoruesi-admin>
set -euo pipefail
ADMIN="${1:?jepni emrin e përdoruesit admin}"
id "$ADMIN" >/dev/null || { echo "Përdoruesi $ADMIN nuk ekziston"; exit 1; }
[ -s "/home/$ADMIN/.ssh/authorized_keys" ] || { echo "Shtoni çelësin SSH te /home/$ADMIN/.ssh/authorized_keys para se të vazhdoni"; exit 1; }

apt-get update && apt-get -y upgrade
apt-get install -y ufw fail2ban unattended-upgrades ca-certificates curl

# Firewall: vetëm SSH, HTTP, HTTPS
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# SSH: pa fjalëkalim, pa root
cat > /etc/ssh/sshd_config.d/99-globi.conf <<CONF
PasswordAuthentication no
PermitRootLogin no
KbdInteractiveAuthentication no
AllowUsers $ADMIN
CONF
systemctl reload ssh || systemctl reload sshd

# Fail2ban për SSH
cat > /etc/fail2ban/jail.d/globi.conf <<CONF
[sshd]
enabled = true
maxretry = 5
bantime = 1h
CONF
systemctl enable --now fail2ban

# Përditësime sigurie automatike
dpkg-reconfigure -f noninteractive unattended-upgrades

# Docker (repo zyrtar)
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker "$ADMIN"
fi
# Docker anashkalon UFW për portat e publikuara; ne publikojmë vetëm 80/443 nga nginx, gjithçka tjetër është në rrjet të brendshëm.
echo "Serveri u sigurua. Hyni sërish si $ADMIN."
