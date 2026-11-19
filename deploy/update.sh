#!/usr/bin/env bash
# update.sh — обновление установленного trigger до новой версии из архива.
#
# Запуск ВНУТРИ каталога установленного приложения:
#   bash deploy/update.sh /путь/к/trigger-v<новая>.tar.gz
# Что делает:
#   1) бэкап .env и базы (db/custom.db) в backup/<дата>/;
#   2) распаковка нового архива и замена кода (.env и БД не трогаются);
#   3) bun install + prisma db push (миграция схемы без потери данных);
#   4) напоминание о рестарте (PM2: pm2 restart trigger; systemd: systemctl restart).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE="${1:-}"
cd "$APP_DIR"

log() { printf '\033[1;32m[update]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[update]\033[0m ОШИБКА: %s\n' "$*" >&2; exit 1; }

[ -n "$ARCHIVE" ] || die "укажите архив: bash deploy/update.sh trigger-v<версия>.tar.gz"
[ -f "$ARCHIVE" ] || die "архив не найден: $ARCHIVE"
case "$ARCHIVE" in
  /*) ;;
  *) ARCHIVE="$APP_DIR/$ARCHIVE" ;;
esac

command -v bun >/dev/null 2>&1 || die "не найден bun"
[ -f .env ] || die "в $APP_DIR нет .env — это не установленное приложение? (сначала install.sh)"

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$APP_DIR/backup/$STAMP"
mkdir -p "$BACKUP_DIR"

# --- 1. бэкап ---
log "бэкап → $BACKUP_DIR"
cp .env "$BACKUP_DIR/env.bak"
if [ -f db/custom.db ]; then
  cp db/custom.db "$BACKUP_DIR/custom.db.bak"
  log "база: db/custom.db ($(wc -c < db/custom.db | tr -d ' ') байт)"
fi

# --- 2. замена кода ---
TMP_EXTRACT="$(mktemp -d)"
log "распаковка $ARCHIVE"
tar -xzf "$ARCHIVE" -C "$TMP_EXTRACT"
NEW_DIR="$(find "$TMP_EXTRACT" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
[ -n "$NEW_DIR" ] && [ -f "$NEW_DIR/.next/standalone/server.js" ] \
  || die "в архиве нет .next/standalone/server.js (архив повреждён?)"

log "замена кода (кроме .env, db/, backup/)"
rsync -a --delete \
  --exclude '.env' \
  --exclude 'db' \
  --exclude 'backup' \
  --exclude 'node_modules' \
  "$NEW_DIR/" "$APP_DIR/"

# --- 3. зависимости + схема ---
log "bun install"
bun install
log "prisma db push (миграция схемы, данные сохраняются)"
bunx prisma db push --skip-generate
bunx prisma generate

# standalone-сервер читает переменные из своего каталога — обновляем копию .env
log "копия .env → .next/standalone/.env (для сервера)"
cp .env .next/standalone/.env

rm -rf "$TMP_EXTRACT"

# --- 4. рестарт ---
log "обновление завершено. Перезапустите сервер:"
cat <<EOF

=====================================================================
 РЕСТАРТ (выберите свой способ)
   PM2:      pm2 restart trigger
   systemd:  systemctl restart trigger
   вручную:  остановите процесс и запустите заново:
             PORT=${PORT:-3000} node .next/standalone/server.js

 Откат (если что-то пошло не так):
   cp "$BACKUP_DIR/env.bak" .env
   cp "$BACKUP_DIR/custom.db.bak" db/custom.db
   (код предыдущей версии — заново распаковать её архив + bun install)
 Бэкап этой версии: $BACKUP_DIR
=====================================================================
EOF
