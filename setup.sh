#!/bin/bash
# Sets up nginx + HTTPS for the LudoMeet admin panel and website.
set -e
mkdir -p /var/www/ludomeet
cp -r admin site /var/www/ludomeet/
cat > /etc/nginx/sites-available/ludomeet <<'NG'
server {
    listen 80;
    server_name admin.playludomeet.com;
    root /var/www/ludomeet/admin;
    index index.html;
    add_header X-Frame-Options SAMEORIGIN;
    location / { try_files $uri /index.html; }
}
server {
    listen 80 default_server;
    server_name playludomeet.com www.playludomeet.com;
    root /var/www/ludomeet/site;
    index index.html;
    location / { try_files $uri $uri/ =404; }
}
NG
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/ludomeet /etc/nginx/sites-enabled/ludomeet
nginx -t && systemctl reload nginx
certbot --nginx --non-interactive --agree-tos -m allinbazarofficial@gmail.com --redirect \
  -d admin.playludomeet.com -d playludomeet.com -d www.playludomeet.com || echo "CERT_FAILED (DNS may not be ready yet)"
echo SETUP_DONE
