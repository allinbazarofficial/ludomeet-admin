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
    location /store/ { add_header Access-Control-Allow-Origin "*"; try_files $uri =404; }
    location /game {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
    location ~ ^/join { try_files /join.html =404; }
}
NG
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/ludomeet /etc/nginx/sites-enabled/ludomeet
nginx -t && systemctl reload nginx
certbot --nginx --non-interactive --agree-tos -m allinbazarofficial@gmail.com --redirect \
  -d admin.playludomeet.com -d playludomeet.com -d www.playludomeet.com || echo "CERT_FAILED (DNS may not be ready yet)"

# ---- Game server (online Ludo + coins) ----
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null && apt-get install -y nodejs >/dev/null
fi
mkdir -p /opt/ludomeet-game
cp game-server/*.js game-server/package.json /opt/ludomeet-game/
(cd /opt/ludomeet-game && npm install --omit=dev --silent >/dev/null 2>&1)
cat > /etc/systemd/system/ludomeet-game.service <<'UNIT'
[Unit]
Description=LudoMeet game server
After=network.target
[Service]
WorkingDirectory=/opt/ludomeet-game
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
if [ -f /opt/ludomeet-game/service-account.json ]; then
  chmod 600 /opt/ludomeet-game/service-account.json
  systemctl enable --now ludomeet-game >/dev/null 2>&1; systemctl restart ludomeet-game
  sleep 2; curl -s http://127.0.0.1:8090/health && echo " GAME_OK"
else
  echo "GAME_WAITING_FOR_KEY"
fi
echo SETUP_DONE
