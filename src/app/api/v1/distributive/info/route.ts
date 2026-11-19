// GET /api/v1/distributive/info — сведения о свежем дистрибутиве (download/latest.json).
// Доступ — только ADMIN (архив содержит полный серверный код панели).
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api';
import { readDistributiveMeta, type DistributiveMeta } from '@/lib/services/distributive';

export const GET = withAuth(
  async (_req: NextRequest): Promise<NextResponse> => {
    let meta: DistributiveMeta | null = null;
    try {
      meta = await readDistributiveMeta();
    } catch {
      // нет latest.json / некорректный JSON — отдаём exists:false
    }
    return NextResponse.json({
      version: meta?.version ?? '',
      date: meta?.date ?? '',
      sizeBytes: meta?.sizeBytes ?? 0,
      sha256: meta?.sha256 ?? '',
      exists: meta !== null,
      src: meta?.src ?? null,
      repo: meta?.repo ?? null,
      public: meta?.public ?? null,
    });
  },
  { read: 'ADMIN' },
);
