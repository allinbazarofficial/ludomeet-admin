#!/bin/bash
# One-line installer: downloads the latest admin panel + website and sets up nginx/HTTPS.
set -e
rm -rf /tmp/lm && git clone -q --depth 1 https://github.com/allinbazarofficial/ludomeet-admin.git /tmp/lm
cd /tmp/lm && bash setup.sh
