// GET /api/v1/distributive — скачивание архива дистрибутива (только ADMIN:
// архив содержит полный серверный код панели).
// ?type=full (по умолчанию) — полный standalone-архив; ?type=src — лёгкий
// исходный; ?type=repo — git-бандл репозитория (клонируется git clone);
// ?type=public — публичный zip-архив для GitHub (с каталогом .git —
// «push-ready» локальный репозиторий). Файл отдаётся потоком
// (fs.createReadStream → web stream) без чтения в память.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';
import { ApiError, withAuth } from '@/lib/api';
import { distributiveArchivePath, readDistributiveMeta, type DistributiveMeta } from '@/lib/services/distributive';

export const GET = withAuth(
  async (req: NextRequest): Promise<Response> => {
    const typeParam = req.nextUrl.searchParams.get('type');
    const kind =
      typeParam === 'src' || typeParam === 'repo' || typeParam === 'public' ? typeParam : 'full';
    let meta;
    try {
      meta = await readDistributiveMeta();
    } catch {
      throw new ApiError(404, 'Архив не найден', 'Дистрибутив не собран: выполните deploy/build-archive.sh');
    }

    // Выбор блока манифеста по типу артефакта (full живёт в корне манифеста,
    // остальные — в опциональных блоках src/repo/public).
    const chosen = pickArtifact(meta, kind);
    if (kind !== 'full' && !chosen) {
      const label =
        kind === 'src'
          ? 'Исходный архив'
          : kind === 'repo'
            ? 'Git-бандл'
            : 'Публичный архив для GitHub';
      throw new ApiError(
        404,
        `${label} не найден`,
        'Соберите дистрибутив свежей версией build-archive.sh',
      );
    }
    const filePath = distributiveArchivePath(chosen ? chosen.filename : meta.filename);
    const expectedSize = chosen ? chosen.sizeBytes : meta.sizeBytes;

    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch {
      throw new ApiError(404, 'Архив не найден', 'Файл из latest.json отсутствует в download/');
    }
    if (size !== expectedSize) {
      throw new ApiError(409, 'Архив изменён', 'Размер файла не совпадает с latest.json — пересоберите дистрибутив');
    }

    const nodeStream = createReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
    // Content-Type по расширению артефакта: tar.gz — application/gzip,
    // zip — application/zip, git-бандл — бинарный поток (git сам распознаёт
    // формат при клонировании из файла)
    const artifactName = chosen ? chosen.filename : meta.filename;
    const contentType = artifactName.endsWith('.bundle')
      ? 'application/octet-stream'
      : artifactName.endsWith('.zip')
        ? 'application/zip'
        : 'application/gzip';
    return new Response(webStream, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${artifactName}"`,
        'Content-Length': String(size),
        'X-Checksum-Sha256': chosen ? chosen.sha256 : meta.sha256,
      },
    });
  },
  { read: 'ADMIN' },
);

/** Выбор блока манифеста по типу артефакта: full — корень манифеста,
 *  src/repo/public — соответствующие опциональные блоки latest.json. */
function pickArtifact(
  meta: DistributiveMeta,
  kind: 'full' | 'src' | 'repo' | 'public',
): { filename: string; sizeBytes: number; sha256: string } | undefined {
  if (kind === 'src') return meta.src;
  if (kind === 'repo') return meta.repo;
  if (kind === 'public') return meta.public;
  return undefined; // full — поля корня манифеста (filename/sizeBytes/sha256)
}
