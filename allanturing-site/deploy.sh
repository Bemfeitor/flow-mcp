#!/usr/bin/env bash
# Publica allanturing.com numa VPS Ubuntu/Debian. Rode como root, de dentro desta pasta:
#   bash deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

apt-get update
apt-get install -y nginx certbot python3-certbot-nginx

mkdir -p /var/www/allanturing.com
cp index.html /var/www/allanturing.com/index.html

cp nginx.conf /etc/nginx/sites-available/allanturing.com
ln -sf /etc/nginx/sites-available/allanturing.com /etc/nginx/sites-enabled/allanturing.com
nginx -t
systemctl reload nginx

echo
echo "Site no ar em http://allanturing.com (quando o DNS apontar para esta VPS)."
echo "Para ativar HTTPS, depois do DNS propagado:"
echo "  certbot --nginx -d allanturing.com -d www.allanturing.com"
