// Сервис дистрибутива: чтение download/latest.json и путь к архиву сборки.
// Архивы собирает deploy/build-archive.sh на машине разработки (НЕ на боевой).
// Домен: распространение панели — карточка «Дистрибутив» во вкладке
// «Документация» и скачивание архивов для развёртывания на сервере компании.
// Вызывается из API-роутов: /api/v1/distributive/info (GET — карточка),
// /distributive (GET — поток архива full/src/repo/public; доступ ADMIN).
// Таблиц Prisma нет — только ФС: download/latest.json + архивы (tar.gz + git-бандл).
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Допустимое имя артефакта (защита от path traversal при подмене latest.json):
 *  полный/исходный архив — trigger-v*.tar.gz;
 *  git-бандл репозитория — trigger-repo-v*.bundle;
 *  публичный архив для GitHub — trigger-public-v*.zip (zip — чтобы Windows
 *  распаковывал без 7-Zip; tar.gz требует сторонний архиватор).
 *  Расширение допускается любое из трёх для любого блока — манифест строит
 *  серверный скрипт сборки, а не клиент. */
const ARCHIVE_NAME_RE = /^trigger-(?:(?:repo|public)-)?v[\w.-]+\.(?:tar\.gz|bundle|zip)$/;

/** Каталог сборок — <корень проекта>/download.
 *  В dev корень = process.cwd(); в standalone-режиме сервер делает chdir в
 *  .next/standalone, поэтому предусмотрен кандидат «на два уровня выше». */
function downloadDir(): string {
  const primary = path.join(process.cwd(), 'download');
  if (existsSync(path.join(primary, 'latest.json'))) return primary;
  return path.join(process.cwd(), '..', '..', 'download');
}

/** Манифест latest.json: версия, дата, размер и sha256 полного архива;
 *  опциональные блоки — src (лёгкий исходный архив), repo (git-бандл
 *  репозитория — чистый снапшот кода) и public (публичный архив для GitHub —
 *  тот же снапшот, упакованный tar.gz вместе с каталогом .git — «push-ready»). */
export interface DistributiveMeta {
  version: string;
  date: string;
  sizeBytes: number;
  sha256: string;
  /** Имя файла архива в download/. */
  filename: string;
  /** Лёгкий исходный архив (опционально, собирается тем же build-скриптом). */
  src?: ArtifactBlock;
  /** Git-бандл репозитория (опционально, свежие сборки): ЧИСТЫЙ снапшот
   *  кода без истории разработки — для публикации на git-сервер
   *  (клонируется `git clone <файл>.bundle`). */
  repo?: ArtifactBlock;
  /** Публичный архив для GitHub (опционально, свежие сборки): тот же чистый
   *  снапшот кода, но zip С каталогом .git (fresh init + initial commit) —
   *  разворачивается как готовый локальный репозиторий: распаковать и
   *  добавить remote (или «Add local repository» в GitHub Desktop).
   *  Zip, а не tar.gz — Windows распаковывает двойным кликом без 7-Zip. */
  public?: ArtifactBlock;
}

/** Общий вид опционального блока артефакта манифеста (src/repo/public). */
interface ArtifactBlock {
  filename: string;
  sizeBytes: number;
  sha256: string;
}

/** Имя архива по версии (используется и build-скриптом, и маршрутом скачивания). */
export function distributiveArchiveName(version: string): string {
  return `trigger-v${version}.tar.gz`;
}

/** Тип архива для скачивания: полный standalone, лёгкий исходный,
 *  git-бандл репозитория или публичный архив для GitHub (repo/public —
 *  чистые снапшоты кода без истории разработки). */
export type DistributiveKind = 'full' | 'src' | 'repo' | 'public';

/** Чтение latest.json; бросает исключение, если файла нет или он некорректен. */
export async function readDistributiveMeta(): Promise<DistributiveMeta> {
  const raw = await readFile(path.join(downloadDir(), 'latest.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('latest.json: ожидается объект');
  }
  const obj = parsed as Record<string, unknown>;
  const { version, date, sizeBytes, sha256 } = obj;
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('latest.json: некорректное поле version');
  }
  if (typeof date !== 'string' || date.trim() === '') {
    throw new Error('latest.json: некорректное поле date');
  }
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error('latest.json: некорректное поле sizeBytes');
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new Error('latest.json: некорректное поле sha256');
  }
  const filename = distributiveArchiveName(version);
  if (!ARCHIVE_NAME_RE.test(filename)) {
    throw new Error(`latest.json: недопустимое имя архива «${filename}»`);
  }

  // Опциональные блоки артефактов (src/repo/public) — единый валидатор выше;
  // отсутствие блока не ошибка (артефакт могли не собрать/старая сборка).
  const src = readArtifactBlock(obj, 'src');
  const repo = readArtifactBlock(obj, 'repo');
  const publicArchive = readArtifactBlock(obj, 'public');

  return { version, date, sizeBytes, sha256, filename, src, repo, public: publicArchive };
}

/** Валидация опционального блока артефакта манифеста (src/repo/public):
 *  имя обязано проходить ARCHIVE_NAME_RE (анти path traversal), размер —
 *  положительное число, sha256 — 64 hex-символа. Отсутствие/null — не ошибка
 *  (артефакт опционален — например, сборка без блока public). */
function readArtifactBlock(
  obj: Record<string, unknown>,
  key: 'src' | 'repo' | 'public',
): ArtifactBlock | undefined {
  const raw = obj[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error(`latest.json: некорректный блок ${key}`);
  const b = raw as Record<string, unknown>;
  if (
    typeof b.filename !== 'string' ||
    !ARCHIVE_NAME_RE.test(b.filename) ||
    typeof b.sizeBytes !== 'number' ||
    !Number.isFinite(b.sizeBytes) ||
    b.sizeBytes <= 0 ||
    typeof b.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(b.sha256)
  ) {
    throw new Error(`latest.json: некорректные поля ${key}`);
  }
  return { filename: b.filename, sizeBytes: b.sizeBytes, sha256: b.sha256 };
}

/** Абсолютный путь к архиву (имя обязательно проходит ARCHIVE_NAME_RE). */
export function distributiveArchivePath(filename: string): string {
  if (!ARCHIVE_NAME_RE.test(filename)) {
    throw new Error(`Недопустимое имя архива «${filename}»`);
  }
  return path.join(downloadDir(), filename);
}
