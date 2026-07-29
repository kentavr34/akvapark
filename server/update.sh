#!/usr/bin/env bash
# ==========================================================================
#  Обновление игры на сервере: GitHub -> /opt/akvapark/www
#  Запускается таймером раз в минуту и вручную.
#  Принцип: сначала полностью готовим новые файлы, потом одним движением
#  подменяем. Игрок никогда не получает половину старой и половину новой игры.
# ==========================================================================
set -euo pipefail

BASE=/opt/akvapark
REPO=$BASE/repo
WWW=$BASE/www
LOG=$BASE/logs/update.log
BRANCH=${AKVA_BRANCH:-main}

mkdir -p "$BASE/logs" "$WWW" "$BASE/dist"
exec >>"$LOG" 2>&1
say(){ echo "[$(date '+%F %T')] $*"; }

# Один обновляющий за раз. Без замка таймер и ручной запуск могут совпасть
# и подменять файлы одновременно — это ровно тот случай, когда игрок ловит
# полуобновлённую игру.
exec 9>"$BASE/.update.lock"
if ! flock -n 9; then
  exit 0
fi

cd "$REPO"

git fetch --quiet origin "$BRANCH"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ] && [ -f "$WWW/index.html" ]; then
  exit 0
fi

say "новая версия: ${LOCAL:0:7} -> ${REMOTE:0:7}"
git reset --hard --quiet "origin/$BRANCH"

# --- проверка целостности до выкладки ---
NEW_INDEX="$REPO/index.html"
if [ ! -s "$NEW_INDEX" ] || ! grep -q '</html>' "$NEW_INDEX"; then
  say "ОТМЕНА: index.html битый или пустой, оставляю прежнюю версию"
  exit 1
fi
JSON_BUILD=$(grep -o '"build"[[:space:]]*:[[:space:]]*[0-9]\+' "$REPO/version.json" | grep -o '[0-9]\+$' || echo "")
JSON_VER=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$REPO/version.json" | sed 's/.*"\([^"]*\)"$/\1/' || echo "")
if [ -z "$JSON_BUILD" ] || [ -z "$JSON_VER" ]; then
  say "ОТМЕНА: version.json не читается (build='$JSON_BUILD' version='$JSON_VER')"
  exit 1
fi
HTML_BUILD=$(grep -o 'const AKVA_BUILD = [0-9]\+' "$NEW_INDEX" | grep -o '[0-9]\+$' || echo "")
if [ "$HTML_BUILD" != "$JSON_BUILD" ]; then
  say "ОТМЕНА: номера сборки разошлись (html=$HTML_BUILD json=$JSON_BUILD) — игроки зациклятся на обновлении"
  exit 1
fi

# --- выкладка: сначала файлы игры, version.json последним ---
STAGE=$(mktemp -d "$BASE/.stage.XXXXXX")
cp -a "$REPO/index.html" "$REPO/sw.js" "$REPO/manifest.webmanifest" "$STAGE/"
cp -a "$REPO/icons" "$STAGE/icons"
cp -a "$REPO/version.json" "$STAGE/version.json.new"

mkdir -p "$WWW/icons"
mv -f "$STAGE/index.html"          "$WWW/index.html"
mv -f "$STAGE/sw.js"               "$WWW/sw.js"
mv -f "$STAGE/manifest.webmanifest" "$WWW/manifest.webmanifest"
cp -a "$STAGE/icons/." "$WWW/icons/"
mv -f "$STAGE/version.json.new"    "$WWW/version.json"   # сигнал «игра обновилась»
rm -rf "$STAGE"

chown -R www-data:www-data "$WWW" 2>/dev/null || true
say "выложена сборка $JSON_BUILD (версия $JSON_VER)"
