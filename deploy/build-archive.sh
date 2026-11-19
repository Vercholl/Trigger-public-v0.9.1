#!/usr/bin/env bash
# build-archive.sh — сборка распространяемого архива trigger (standalone).
#
# ЧТО ДЕЛАЕТ:
#   1. rsync-копия проекта во /tmp/trigger-dist-src (живой проект и .next НЕ трогаются:
#      dev-сервер с Turbopack продолжает работать); внутренние исследовательские
#      материалы docs/altcraft-* (справочник исследования) в копию НЕ попадают —
#      это рабочий справочник, а не поставляемая документация;
#   2. в копии: bun install → prisma generate → bun run build (output:'standalone');
#   3. собирает staging-каталог: .next/standalone + .next/static + public + prisma +
#      src (нужен prisma/seed.ts) + package.json + .env.example + deploy/*.sh + README;
#   4. упаковывает в download/trigger-v<версия>.tar.gz и пишет download/latest.json
#      {version, date, sizeBytes, sha256} + src{filename, sizeBytes, sha256};
#   5. ДОПОЛНИТЕЛЬНО собирает лёгкий исходный архив trigger-v<версия>-src.tar.gz
#      (~0,8 МБ: только исходники/конфиги/документация без зависимостей — для
#      разработки/git-ops; разворачивается bun install + bun run build, нужен интернет);
#   6. ДОПОЛНИТЕЛЬНО собирает из свежего репозитория ДВА артефакта публикации:
#      git-бандл trigger-repo-v<версия>.bundle (клонируется git clone) и публичный
#      zip trigger-public-v<версия>.zip с каталогом .git («push-ready» — для
#      GitHub без консольного git; zip — Windows распаковывает без 7-Zip).
#      Оба — ЧИСТЫЙ снапшот без истории разработки.
#
# Запуск (на машине разработки): bash deploy/build-archive.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_SRC="/tmp/trigger-dist-src"
TMP_STAGE="/tmp/trigger-dist-stage"
DOWNLOAD_DIR="$ROOT/download"
readonly ROOT TMP_SRC TMP_STAGE DOWNLOAD_DIR

VERSION="$(node -e "console.log(require('$ROOT/package.json').version)")"
ARCHIVE_NAME="trigger-v${VERSION}.tar.gz"
ARCHIVE_PATH="$DOWNLOAD_DIR/$ARCHIVE_NAME"
APP_DIR="trigger-v${VERSION}"

log() { printf '\033[1;32m[build-archive]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[build-archive]\033[0m ОШИБКА: %s\n' "$*" >&2; exit 1; }

command -v bun >/dev/null 2>&1 || die "не найден bun (установите: curl -fsSL https://bun.sh/install | bash)"
command -v rsync >/dev/null 2>&1 || die "не найден rsync"
command -v git >/dev/null 2>&1 || die "не найден git (нужен для git-бандла репозитория)"
command -v zip >/dev/null 2>&1 || die "не найден zip (нужен для публичного архива для GitHub)"

log "версия из package.json: $VERSION"

# --- 0. next.config.ts обязан содержать output:'standalone' (безопасно и для dev) ---
if ! grep -q "standalone" "$ROOT/next.config.ts"; then
  die "next.config.ts не содержит output:'standalone' — добавьте и повторите сборку"
fi

# --- 1. rsync-копия проекта (без артефактов dev) ---
# Исследовательские материалы (справочник Altcraft, нагрузочный отчёт, SPEC.md —
# внутренняя спецификация, docs/mts — вендорские PDF МТС) остаются только в
# git-репозитории — в дистрибутив они не попадают: это рабочие справочники,
# а не поставляемая документация.
# db исключён ЦЕЛИКОМ: сборке БД не нужна (env-заглушка ниже), а кроме *.db
# бывают живые WAL/SHM-файлы (custom.db-wal/-shm) — их утечка в src-архив/
# git-бандл недопустима (фрагменты демо-данных в бинарном виде).
log "rsync → $TMP_SRC"
rm -rf "$TMP_SRC"
rsync -a --delete \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude '.git' \
  --exclude 'db' \
  --exclude 'dev.log' \
  --exclude 'server.log' \
  --exclude 'skills' \
  --exclude 'upload' \
  --exclude 'download' \
  --exclude 'tool-results' \
  --exclude '.env' \
  --exclude 'worklog.md' \
  --exclude 'SPEC.md' \
  --exclude 'mini-services' \
  --exclude 'docs/altcraft-research' \
  --exclude 'docs/altcraft-study-2026-10.md' \
  --exclude 'docs/loadtest-report.md' \
  --exclude 'docs/mts' \
  --exclude '*.tsbuildinfo' \
  "$ROOT/" "$TMP_SRC/"

# Минимальный .env для сборки (prisma generate / next build не ходят в БД,
# но переменные должны существовать)
cat > "$TMP_SRC/.env" <<'EOF'
DATABASE_URL=file:./db/custom.db
SESSION_SECRET=build-placeholder
UNSUBSCRIBE_SECRET=build-placeholder
EVENTS_API_KEY=build-placeholder
ADMIN_EMAIL=build@localhost
ADMIN_PASSWORD=build-placeholder
EOF

# --- 2. сборка в копии ---
cd "$TMP_SRC"
log "bun install"
bun install --frozen-lockfile >/dev/null 2>&1 || bun install
log "prisma generate"
bunx prisma generate >/dev/null
log "bun --smol run build (standalone) — это может занять несколько минут"
# --smol: снижает аппетит bun к памяти при сборке (урок Task 31: без него на 4 ГБ RAM
# с живым dev-сервером процесс убивает OOM-killer'ом). Блокирующий запуск обязателен.
bun --smol run build

[ -f "$TMP_SRC/.next/standalone/server.js" ] || die "не найден .next/standalone/server.js после сборки"

# --- 3. staging-каталог архива ---
log "staging → $TMP_STAGE/$APP_DIR"
rm -rf "$TMP_STAGE"
mkdir -p "$TMP_STAGE/$APP_DIR/.next" "$TMP_STAGE/$APP_DIR/deploy"
cp -r "$TMP_SRC/.next/standalone" "$TMP_STAGE/$APP_DIR/.next/standalone"
# .env-заглушка сборки не должна попасть в дистрибутив: сервер в standalone-режиме
# читает переменные из своего каталога — секреты задаёт install.sh (.next/standalone/.env)
rm -f "$TMP_STAGE/$APP_DIR/.next/standalone/.env"
cp -r "$TMP_SRC/.next/static" "$TMP_STAGE/$APP_DIR/.next/static"
cp -r "$TMP_SRC/public" "$TMP_STAGE/$APP_DIR/public"
mkdir -p "$TMP_STAGE/$APP_DIR/prisma"
cp "$TMP_SRC/prisma/schema.prisma" "$TMP_STAGE/$APP_DIR/prisma/schema.prisma"
cp "$TMP_SRC/prisma/seed.ts" "$TMP_STAGE/$APP_DIR/prisma/seed.ts"
# seed.ts импортирует src/lib/{sms/render, compliance/disclaimer} — берём весь src
cp -r "$TMP_SRC/src" "$TMP_STAGE/$APP_DIR/src"
cp "$TMP_SRC/package.json" "$TMP_STAGE/$APP_DIR/package.json"
cp "$TMP_SRC/.env.example" "$TMP_STAGE/$APP_DIR/.env.example"
cp "$ROOT/deploy/install.sh" "$TMP_STAGE/$APP_DIR/deploy/install.sh"
cp "$ROOT/deploy/update.sh" "$TMP_STAGE/$APP_DIR/deploy/update.sh"

cat > "$TMP_STAGE/$APP_DIR/README.txt" <<EOF
trigger v${VERSION} — дистрибутив (standalone)
==================================================

Панель триггерных SMS-коммуникаций (open source).
Состав архива:
  .next/standalone/  — автономный сервер Next.js (node .next/standalone/server.js)
  .next/static/      — статика приложения
  public/            — публичные файлы
  prisma/            — схема БД (schema.prisma) и сид (seed.ts)
  src/               — исходники, необходимые сиду (импортируются из prisma/seed.ts)
  deploy/            — install.sh (установка) и update.sh (обновление версии)
  .env.example       — пример переменных окружения

УСТАНОВКА (кратко; подробно — install.sh сделает сам):
  1) распакуйте архив: tar xzf ${ARCHIVE_NAME}
  2) cd ${APP_DIR} && bash deploy/install.sh
     — установит зависимости (нужен bun), создаст .env со сгенерированными секретами
       (openssl rand -hex 32; копия кладётся в .next/standalone/.env для сервера),
       применит схему к SQLite (db/custom.db, абсолютный путь), запустит сид
       (создаст администратора из .env: ADMIN_EMAIL / ADMIN_PASSWORD)
  3) запуск: PORT=3000 node .next/standalone/server.js
     Для постоянной работы — PM2:
       pm2 start .next/standalone/server.js --name trigger --env PORT=3000
     или systemd (пример юнита):
       [Service]
       WorkingDirectory=/opt/trigger
       Environment=PORT=3000
       ExecStart=/usr/bin/node .next/standalone/server.js
       Restart=always
  4) откройте http://<host>:<port>, войдите администратором, смените пароль,
     подключите SMS-провайдера во вкладке «Интеграции» (SMS.Tech / Т2 / МТС OmniChannel).

ОБНОВЛЕНИЕ:
  bash deploy/update.sh trigger-v<новая-версия>.tar.gz
  (сохранит резервные копии .env и БД, заменит код, применит схему, напомнит про рестарт)

Документация — в каталоге docs/ и во вкладке «Документация» панели. Сборка: $(date -u +%Y-%m-%dT%H:%M:%SZ).
EOF

# --- 4. tar.gz + latest.json ---
mkdir -p "$DOWNLOAD_DIR"
log "упаковка $ARCHIVE_PATH"
rm -f "$ARCHIVE_PATH"
tar -czf "$ARCHIVE_PATH" -C "$TMP_STAGE" "$APP_DIR"

SIZE_BYTES="$(wc -c < "$ARCHIVE_PATH" | tr -d ' ')"
SHA256="$(sha256sum "$ARCHIVE_PATH" | cut -d' ' -f1)"
DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- 5. Лёгкий исходный архив: только исходники, без зависимостей и сборки ---
# Из TMP_SRC (чистая rsync-копия проекта) берём всё, кроме артефактов сборки:
# корневые конфиги (next.config.ts, tsconfig.json, …) и bun.lock попадают в архив —
# этого достаточно для воспроизводимой сборки на машине с bun.
SRC_ARCHIVE_NAME="trigger-v${VERSION}-src.tar.gz"
SRC_ARCHIVE_PATH="$DOWNLOAD_DIR/$SRC_ARCHIVE_NAME"
log "исходный архив → $SRC_ARCHIVE_PATH"
rm -f "$SRC_ARCHIVE_PATH"
tar -czf "$SRC_ARCHIVE_PATH" -C "$TMP_SRC" \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='.env' \
  --exclude='db' \
  --exclude='*.tsbuildinfo' \
  --exclude='download' \
  .
SRC_SIZE_BYTES="$(wc -c < "$SRC_ARCHIVE_PATH" | tr -d ' ')"
SRC_SHA256="$(sha256sum "$SRC_ARCHIVE_PATH" | cut -d' ' -f1)"

# --- 6. Чистый снапшот кода: git-бандл + публичный архив для GitHub ---
# Из TMP_SRC (rsync-копия проекта без .git) собираем свежий репозиторий:
# git init + initial commit — история разработки и внутренние материалы в
# снапшот НЕ попадают. Из него ДВА артефакта:
#   trigger-repo-v*.bundle — git-бандл (клонируется: git clone <файл>.bundle);
#   trigger-public-v*.zip  — zip вместе с каталогом .git — «push-ready»
#                           (распаковать → добавить remote → push; или GitHub
#                           Desktop «Add local repository» без консольного git).
# Zip, а не tar.gz — Windows 10 распаковывает двойным кликом без 7-Zip.
# Нормализация exec-бита: rsync копирует режимы ФС разработки (всё +x) — в
# снапшоте исходники должны быть 644, исполняемые ТОЛЬКО deploy/*.sh.
PUBLIC_ARCHIVE_NAME="trigger-public-v${VERSION}.zip"
PUBLIC_ARCHIVE_PATH="$DOWNLOAD_DIR/$PUBLIC_ARCHIVE_NAME"
REPO_BUNDLE_NAME="trigger-repo-v${VERSION}.bundle"
REPO_BUNDLE_PATH="$DOWNLOAD_DIR/$REPO_BUNDLE_NAME"
PUBLIC_DIR="/tmp/trigger-public-v${VERSION}"
log "чистый снапшот (git-бандл + публичный архив) → $REPO_BUNDLE_PATH, $PUBLIC_ARCHIVE_PATH"
rm -rf "$PUBLIC_DIR" "$REPO_BUNDLE_PATH" "$PUBLIC_ARCHIVE_PATH"
# из копии сборки берём код; .env-заглушка сборки, артефакты сборки
# (node_modules/.next — нужны только в TMP_SRC для next build) и внутренние
# материалы (worklog, SPEC, справочники, вендорские PDF) в публикацию
# не попадают: tar упаковывает PUBLIC_DIR целиком, не только git-файлы
rsync -a "$TMP_SRC/" "$PUBLIC_DIR/" \
  --exclude '.env' \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude '*.tsbuildinfo' \
  --exclude 'db' \
  --exclude 'worklog.md' \
  --exclude 'SPEC.md' \
  --exclude 'docs/altcraft-research' \
  --exclude 'docs/altcraft-study-2026-10.md' \
  --exclude 'docs/loadtest-report.md' \
  --exclude 'docs/mts'
git -C "$PUBLIC_DIR" init -q -b main
# нормализация режимов ФС: rsync несёт +x со всей ФС разработки — с диска
# снимаем (иначе после распаковки архива git status показывает «M» на каждом
# файле, а коммит пользователя вернул бы +x). Исполняемые — только deploy/*.sh.
find "$PUBLIC_DIR" -path '*/.git' -prune -o -type f -exec chmod 644 {} +
chmod 755 "$PUBLIC_DIR"/deploy/*.sh
# двойная страховка: и в git-индексе те же режимы (add --chmod → 644, точечно +x)
git -C "$PUBLIC_DIR" add --chmod=-x .
git -C "$PUBLIC_DIR" update-index --chmod=+x \
  deploy/build-archive.sh deploy/build-public.sh deploy/install.sh deploy/update.sh
git -C "$PUBLIC_DIR" \
  -c user.name='trigger' -c user.email='build@trigger.local' \
  commit -qm "Initial public release v${VERSION}"
if ! git -C "$PUBLIC_DIR" bundle create "$REPO_BUNDLE_PATH" --all; then
  die "git bundle create завершился с ошибкой"
fi
REPO_SIZE_BYTES="$(wc -c < "$REPO_BUNDLE_PATH" | tr -d ' ')"
REPO_SHA256="$(sha256sum "$REPO_BUNDLE_PATH" | cut -d' ' -f1)"
# публичный архив — тот же репозиторий, упакованный zip ВМЕСТЕ с .git
# (zip сохраняет режимы файлов; -X — без лишних атрибутов расширений)
(cd /tmp && zip -qr -X "$PUBLIC_ARCHIVE_PATH" "trigger-public-v${VERSION}")
PUBLIC_SIZE_BYTES="$(wc -c < "$PUBLIC_ARCHIVE_PATH" | tr -d ' ')"
PUBLIC_SHA256="$(sha256sum "$PUBLIC_ARCHIVE_PATH" | cut -d' ' -f1)"

cat > "$DOWNLOAD_DIR/latest.json" <<EOF
{
  "version": "$VERSION",
  "date": "$DATE",
  "sizeBytes": $SIZE_BYTES,
  "sha256": "$SHA256",
  "src": {
    "filename": "$SRC_ARCHIVE_NAME",
    "sizeBytes": $SRC_SIZE_BYTES,
    "sha256": "$SRC_SHA256"
  },
  "repo": {
    "filename": "$REPO_BUNDLE_NAME",
    "sizeBytes": $REPO_SIZE_BYTES,
    "sha256": "$REPO_SHA256"
  },
  "public": {
    "filename": "$PUBLIC_ARCHIVE_NAME",
    "sizeBytes": $PUBLIC_SIZE_BYTES,
    "sha256": "$PUBLIC_SHA256"
  }
}
EOF

# служебный README в download/ (существующий не перезаписываем, если он не наш)
if [ ! -f "$DOWNLOAD_DIR/README.md" ]; then
  echo 'Архивы дистрибутива (trigger-v*.tar.gz), git-бандл репозитория (trigger-repo-v*.bundle), публичный архив для GitHub (trigger-public-v*.zip) и манифест latest.json.' > "$DOWNLOAD_DIR/README.md"
fi

log "готово: $ARCHIVE_PATH"
log "размер: $SIZE_BYTES байт; sha256: $SHA256"
log "исходники: $SRC_ARCHIVE_PATH ($SRC_SIZE_BYTES байт; sha256: $SRC_SHA256)"
log "git-бандл (чистый снапшот): $REPO_BUNDLE_PATH ($REPO_SIZE_BYTES байт; sha256: $REPO_SHA256)"
log "публичный архив для GitHub: $PUBLIC_ARCHIVE_PATH ($PUBLIC_SIZE_BYTES байт; sha256: $PUBLIC_SHA256)"
log "манифест: $DOWNLOAD_DIR/latest.json"

rm -rf "$TMP_STAGE"
# исходники сборки оставляем в /tmp/trigger-dist-src для отладки; удалить: rm -rf /tmp/trigger-dist-src
