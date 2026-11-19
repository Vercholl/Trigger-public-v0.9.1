// GET /api/health — публичная проверка живости: БД + воркер (lastTickAt ≤ 15 сек).
// Заодно — мягкий самобутстрап БД (схема/админ + канарейка целостности схемы),
// если instrumentation его не завершил (например, отдельный процесс без
// instrumentation). Ошибка бутстрапа честно помечает db: 'fail' — зелёный
// SELECT 1 не должен маскировать рассинхрон схемы с кодом.
// dataSnapshot: 'pending' — в /home/sync/db-backup есть содержательный снапшот,
// а живая БД пуста: авто-восстановление после сброса песочницы не отработало
// (инцидент 27.10: instrumentation поднялся без db-restore — файл не попал в
// repo.tar, т.к. не был закоммичен). Молчаливая потеря данных недопустима —
// health честно отвечает degraded, пока снапшот не восстановлен.
// RBAC: публичный (без авторизации) — для мониторинга/деплоя (curl, балансировщик).
// Ответ всегда 200: деградацию читают по телу (status 'ok'|'degraded', поля
// db/worker/dataSnapshot), HTTP-код намеренно не сигнализирует о проблемах.
import { existsSync, statSync } from 'node:fs';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getWorkerState } from '@/lib/scheduler/worker';
import { ensureDatabaseBootstrap } from '@/lib/db-bootstrap';

const SNAPSHOT_DB = '/home/sync/db-backup/custom.db';
const SNAPSHOT_MIN_BYTES = 4096;

/** Состояние канала сохранности данных: см. комментарий к dataSnapshot. */
async function getDataSnapshotState(): Promise<'ok' | 'pending' | 'n/a'> {
  try {
    const st = existsSync(SNAPSHOT_DB) ? statSync(SNAPSHOT_DB) : null;
    if (!st || st.size < SNAPSHOT_MIN_BYTES) return 'n/a'; // среда без /home/sync — не применимо
    const [users, clients, funnels, templates] = await Promise.all([
      db.user.count(),
      db.client.count(),
      db.funnel.count(),
      db.smsTemplate.count(),
    ]);
    const liveHasData = users > 1 || clients > 0 || funnels > 0 || templates > 0;
    return liveHasData ? 'ok' : 'pending';
  } catch {
    return 'n/a'; // диагностика не должна ронять health
  }
}

export async function GET(): Promise<NextResponse> {
  // Блок БД: самобутстрап (схема/админ + канарейка целостности), затем SELECT 1.
  let dbOk = 'ok';
  try {
    await ensureDatabaseBootstrap();
  } catch (err: unknown) {
    // схема/бутстрап не прошли (например, канарейка целостности) — это деградация БД
    dbOk = 'fail';
    console.error('[health] бутстрап БД не пройден:', err instanceof Error ? err.message : err);
  }
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    dbOk = 'fail';
  }

  // Воркер: жив, если последний тик моложе 15 секунд (getWorkerState — in-memory).
  const state = getWorkerState();
  const workerFresh = state !== null && Date.now() - state.lastTickAt < 15_000;
  const workerOk = workerFresh ? 'ok' : 'fail';
  const dataSnapshot = await getDataSnapshotState();

  // Итог: 'degraded' при db/worker fail или dataSnapshot 'pending'
  // (канал 'n/a' — среда без /home/sync — деградацию не вызывает).
  const body = {
    status:
      dbOk === 'ok' && workerOk === 'ok' && dataSnapshot !== 'pending' ? 'ok' : 'degraded',
    db: dbOk,
    worker: workerOk,
    dataSnapshot,
    time: new Date().toISOString(),
  };
  return NextResponse.json(body, { status: 200 });
}
