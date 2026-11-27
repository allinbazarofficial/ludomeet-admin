#!/bin/bash
# Sets up nginx + HTTPS for the LudoMeet admin panel and website.
set -e
mkdir -p /var/www/ludomeet
cp -r admin site /var/www/ludomeet/
# Latest app for the download link (playludomeet.com/download).
curl -fsSL -o /var/www/ludomeet/site/LudoMeet.apk.new https://github.com/allinbazarofficial/ludomeet-admin/releases/latest/download/LudoMeet.apk \
  && mv /var/www/ludomeet/site/LudoMeet.apk.new /var/www/ludomeet/site/LudoMeet.apk || echo "APK_DOWNLOAD_SKIPPED"

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
    location ~ ^/(download|get|app)/?$ { try_files /download.html =404; }
    location = /LudoMeet.apk {
        types { application/vnd.android.package-archive apk; }
        add_header Content-Disposition 'attachment; filename="LudoMeet.apk"';
        try_files /LudoMeet.apk =404;
    }
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
# Updates wait (up to 40 minutes) for running games to finish before restarting.
KillSignal=SIGTERM
TimeoutStopSec=2400
Environment=NODE_ENV=production
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
# Always running: without the key file it waits in setup mode for
# playludomeet.com/setup-key.html, then restarts with games on.
[ -f /opt/ludomeet-game/service-account.json ] && chmod 600 /opt/ludomeet-game/service-account.json
systemctl enable ludomeet-game >/dev/null 2>&1; systemctl restart --no-block ludomeet-game
sleep 2; echo "GAME_HEALTH $(curl -s http://127.0.0.1:8090/health)"
echo SETUP_DONE
