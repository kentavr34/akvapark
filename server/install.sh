#!/usr/bin/env bash
# ==========================================================================
#  Разовая установка игры на сервер №2 (45.67.216.36).
#  Всё живёт в /opt/akvapark и не пересекается с другими проектами сервера.
#  Запуск от root:  bash install.sh
# ==========================================================================
set -euo pipefail

BASE=/opt/akvapark
GIT_URL=${AKVA_GIT:-https://github.com/kentavr34/akvapark.git}
BRANCH=${AKVA_BRANCH:-main}
PORT=8090

echo "==> каталоги"
mkdir -p "$BASE"/{www,dist,logs}

echo "==> код игры из GitHub"
if [ -d "$BASE/repo/.git" ]; then
  git -C "$BASE/repo" remote set-url origin "$GIT_URL"
  git -C "$BASE/repo" fetch --quiet origin "$BRANCH"
  git -C "$BASE/repo" reset --hard --quiet "origin/$BRANCH"
else
  git clone --quiet --branch "$BRANCH" "$GIT_URL" "$BASE/repo"
fi
chmod +x "$BASE/repo/server/"*.sh

echo "==> nginx"
install -m 644 "$BASE/repo/server/akvapark-common.conf" /etc/nginx/snippets/akvapark-common.conf
install -m 644 "$BASE/repo/server/nginx-akvapark.conf"  /etc/nginx/sites-available/akvapark
ln -sfn /etc/nginx/sites-available/akvapark /etc/nginx/sites-enabled/akvapark
nginx -t
systemctl reload nginx

echo "==> firewall"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow "$PORT"/tcp >/dev/null || true
fi

echo "==> автообновление раз в минуту"
install -m 644 "$BASE/repo/server/akvapark-update.service" /etc/systemd/system/akvapark-update.service
install -m 644 "$BASE/repo/server/akvapark-update.timer"   /etc/systemd/system/akvapark-update.timer
systemctl daemon-reload
systemctl enable --now akvapark-update.timer

echo "==> первая выкладка"
"$BASE/repo/server/update.sh" || true

echo
echo "Готово. Веб-версия: http://$(curl -s -4 ifconfig.me || echo 45.67.216.36):$PORT/"
echo "Логи выкладки:      $BASE/logs/update.log"
