#!/usr/bin/env bash
# install.sh — установка дистрибутива trigger на боевой/тестовый сервер.
#
# Запуск ВНУТРИ распакованного каталога:  bash deploy/install.sh
# Требования: bun (для зависимостей/сида), node ≥ 20, openssl.
# Что делает:
#   1) bun install (зависимости, включая prisma CLI для db push);
#   2) .env из .env.example с НАСТОЯЩИМИ сгенерированными секретами (openssl rand -hex 32)
#      и стойким паролем администратора;
#   3) prisma db push + prisma generate (SQLite db/custom.db);
#   4) сид: администратор из .env (при первом входе панель может потребовать смену пароля);
#   5) печатает инструкцию запуска (node .next/standalone/server.js, PM2/systemd).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

log() { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install]\033[0m ОШИБКА: %s\n' "$*" >&2; exit 1; }

log "установка trigger в $APP_DIR"

# --- требования ---
command -v bun >/dev/null 2>&1 || die "не найден bun (установите: curl -fsSL https://bun.sh/install | bash)"
command -v node >/dev/null 2>&1 || die "не найден node ≥ 20"
command -v openssl >/dev/null 2>&1 || die "не найден openssl"
[ -f .env.example ] || die "нет .env.example рядом с install.sh"
[ -f .next/standalone/server.js ] || die "нет .next/standalone/server.js (архив повреждён?)"

# --- 1. .env ---
if [ -f .env ]; then
  log ".env уже существует — оставляем без изменений (секреты не перегенерируем)"
else
  log "генерация .env со случайными секретами"
  SESSION_SECRET="$(openssl rand -hex 32)"
  UNSUBSCRIBE_SECRET="$(openssl rand -hex 32)"
  SECRETS_KEY="$(openssl rand -hex 32)"
  EVENTS_API_KEY="$(openssl rand -hex 16)"
  ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
  ADMIN_EMAIL="admin@trigger.local"
  # DATABASE_URL — АБСОЛЮТНЫЙ путь: standalone-сервер меняет cwd на .next/standalone,
  # относительный путь нашёл бы базу не там. .env создаётся всегда до этой ветки.
  sed -e "s|^DATABASE_URL=.*|DATABASE_URL=file:${APP_DIR}/db/custom.db|" \
      -e "s|^ADMIN_EMAIL=.*|ADMIN_EMAIL=${ADMIN_EMAIL}|" \
      -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${ADMIN_PASSWORD}|" \
      -e "s|^SESSION_SECRET=.*|SESSION_SECRET=${SESSION_SECRET}|" \
      -e "s|^UNSUBSCRIBE_SECRET=.*|UNSUBSCRIBE_SECRET=${UNSUBSCRIBE_SECRET}|" \
      -e "s|^SECRETS_KEY=.*|SECRETS_KEY=${SECRETS_KEY}|" \
      -e "s|^EVENTS_API_KEY=.*|EVENTS_API_KEY=${EVENTS_API_KEY}|" \
      -e "s|^SMS_PROVIDER=.*|SMS_PROVIDER=sandbox|" \
      -e "s|^ADVERTISER_NAME=.*|ADVERTISER_NAME=«Ваша компания»|" \
      .env.example > .env
  chmod 600 .env
  log "администратор: $ADMIN_EMAIL / пароль: $ADMIN_PASSWORD (сохраните! он только в .env)"
fi

# standalone-сервер читает переменные из СВОЕГО каталога (server.js делает chdir) —
# держим копию .env рядом с server.js и обновляем её при каждой установке/обновлении
log "копия .env → .next/standalone/.env (для сервера)"
cp .env .next/standalone/.env

# Гарантия пути БД для шагов ниже: экспортированная окружением DATABASE_URL имеет
# приоритет над .env (стандарт dotenv) и может увести prisma/сид в чужую БД
# (инцидент песочницы 28.10: глобальная DATABASE_URL → установка прошла по live-БД).
# install.sh только что вписал корректный абсолютный путь в .env — фиксируем его в env.
export DATABASE_URL="file:${APP_DIR}/db/custom.db"

# --- 2. зависимости ---
log "bun install"
bun install

# --- 3. база ---
mkdir -p db
log "prisma db push + generate"
bunx prisma db push --skip-generate
bunx prisma generate

# --- 4. сид (администратор + демо-данные) ---
log "сид (ADMIN_EMAIL/ADMIN_PASSWORD из .env)"
bun prisma/seed.ts

# --- 5. инструкция ---
PORT="${PORT:-3000}"
log "установка завершена."
cat <<EOF

=====================================================================
 ЗАПУСК
   PORT=${PORT} node .next/standalone/server.js
   (порт задаётся переменной PORT; по умолчанию ${PORT})

 Постоянная работа — PM2:
   pm2 start .next/standalone/server.js --name trigger --env PORT=${PORT}
   pm2 save && pm2 startup

 или systemd (юнит /etc/systemd/system/trigger.service):
   [Service]
   WorkingDirectory=${APP_DIR}
   Environment=PORT=${PORT}
   Environment=NODE_ENV=production
   ExecStart=$(command -v node) ${APP_DIR}/.next/standalone/server.js
   Restart=always
   [Install]
   WantedBy=multi-user.target
   # systemctl daemon-reload && systemctl enable --now trigger

 ДАЛЬШЕ
   1) откройте http://<host>:${PORT}, войдите администратором (данные в .env);
   2) смените пароль (меню пользователя);
   3) вкладка «Интеграции»: подключите SMS.Tech (токен из hub.sms.tech)
      или Т2 «Бизнес SMS» и нажмите «Сделать активным»;
   4) проверьте правила отправки во вкладке «Документация».

 ОБНОВЛЕНИЕ ВЕРСИИ
   bash deploy/update.sh trigger-v<новая>.tar.gz
=====================================================================
EOF
