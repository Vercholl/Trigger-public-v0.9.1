#!/usr/bin/env bash
# build-public.sh — сборка ПУБЛИЧНОГО git-репозитория для GitHub.
#
# ЧТО ДЕЛАЕТ:
#   1. rsync-копия проекта (только код/доки/конфиги: БЕЗ .git, node_modules,
#      .next, БД, секретов, рабочих журналов и внутренних материалов —
#      история разработки не публикуется);
#   2. в копии: git init -b main → add → initial commit «Initial public release»;
#   3. упаковка в download/trigger-public-v<версия>.zip (каталог с .git).
#      Zip, а не tar.gz — Windows 10 распаковывает двойным кликом без 7-Zip.
#
# КАК ИСПОЛЬЗОВАТЬ АРХИВ (публикация на GitHub, есть консольный git):
#   unzip trigger-public-v*.zip && cd trigger-public-v*/
#   git remote add origin git@github.com:<user>/trigger.git   # или https://
#   git push -u origin main
# Без консольного git: GitHub Desktop → «Add local repository» → Publish.
#
# Отличие от build-archive.sh: тот собирает боевой standalone-дистрибутив
# (+ src-архив, git-бандл и тот же публичный zip в манифесте); этот —
# максимально простой «push-ready» репозиторий без сборки next build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOWNLOAD_DIR="$ROOT/download"
readonly ROOT DOWNLOAD_DIR

VERSION="$(node -e "console.log(require('$ROOT/package.json').version)")"
PUBLIC_STAGE="/tmp/trigger-public-stage"
PUBLIC_DIR_NAME="trigger-public-v${VERSION}"
ARCHIVE_PATH="$DOWNLOAD_DIR/trigger-public-v${VERSION}.zip"

log() { printf '\033[1;32m[build-public]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[build-public]\033[0m ОШИБКА: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "не найден git"
command -v rsync >/dev/null 2>&1 || die "не найден rsync"
command -v zip >/dev/null 2>&1 || die "не найден zip"

log "версия: $VERSION"

# --- 1. чистая копия проекта (что публиковать) ---
# Всё, что относится к разработке в песочнице/внутренним материалам, — исключено:
# .git (история), БД и архивы ретеншна, секреты, рабочие журналы (worklog/SPEC),
# исследовательские справочники и вендорские PDF-документы (не наше право
# распространять), артефакты сборки и служебные каталоги платформы.
log "rsync → $PUBLIC_STAGE/$PUBLIC_DIR_NAME"
rm -rf "$PUBLIC_STAGE"
mkdir -p "$PUBLIC_STAGE/$PUBLIC_DIR_NAME"
rsync -a "$ROOT/" "$PUBLIC_STAGE/$PUBLIC_DIR_NAME/" \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude 'db' \
  --exclude 'download' \
  --exclude 'upload' \
  --exclude 'skills' \
  --exclude 'tool-results' \
  --exclude 'mini-services' \
  --exclude 'examples' \
  --exclude 'tests' \
  --exclude '.zscripts' \
  --exclude '.claude' \
  --exclude '.env' \
  --exclude 'dev.log' \
  --exclude 'server.log' \
  --exclude '*.log' \
  --exclude '*.tsbuildinfo' \
  --exclude 'worklog.md' \
  --exclude 'SPEC.md' \
  --exclude 'docs/altcraft-research' \
  --exclude 'docs/altcraft-study-2026-10.md' \
  --exclude 'docs/loadtest-report.md' \
  --exclude 'docs/mts'

# --- 2. свежий репозиторий без истории разработки ---
cd "$PUBLIC_STAGE/$PUBLIC_DIR_NAME"
log "git init + initial commit"
git init -q -b main
# нормализация exec-бита (двойная): rsync переносит режимы ФС разработки (всё +x) —
# правим и диск (иначе после распаковки git status шумит «M», а коммит вернул бы +x),
# и git-индекс; исходники 644, исполняемые только deploy/*.sh.
find . -path '*/.git' -prune -o -type f -exec chmod 644 {} +
chmod 755 deploy/*.sh
git add --chmod=-x .
git update-index --chmod=+x \
  deploy/build-archive.sh deploy/build-public.sh deploy/install.sh deploy/update.sh
git \
  -c user.name='trigger' -c user.email='build@trigger.local' \
  commit -qm "Initial public release v${VERSION}"

# страховка: в публикуемом дереве не должно остаться секретов и служебных следов
if [ -f .env ]; then die "в публикацию попал .env — исключите и пересоберите"; fi
if git ls-files | grep -qE '(^|/)\.env$'; then die "в git попал .env"; fi

# --- 3. упаковка ---
mkdir -p "$DOWNLOAD_DIR"
log "упаковка $ARCHIVE_PATH"
rm -f "$ARCHIVE_PATH"
(cd "$PUBLIC_STAGE" && zip -qr -X "$ARCHIVE_PATH" "$PUBLIC_DIR_NAME")

SIZE_BYTES="$(wc -c < "$ARCHIVE_PATH" | tr -d ' ')"
SHA256="$(sha256sum "$ARCHIVE_PATH" | cut -d' ' -f1)"
FILES_COUNT="$(git ls-files | wc -l | tr -d ' ')"

log "готово: $ARCHIVE_PATH"
log "размер: $SIZE_BYTES байт; файлов в репозитории: $FILES_COUNT; sha256: $SHA256"
log ""
log "ПУБЛИКАЦИЯ НА GITHUB:"
log "  unzip $(basename "$ARCHIVE_PATH") && cd $PUBLIC_DIR_NAME"
log "  git remote add origin git@github.com:<user>/trigger.git"
log "  git push -u origin main"
log "  без консольного git: GitHub Desktop → Add local repository → Publish"

rm -rf "$PUBLIC_STAGE"
