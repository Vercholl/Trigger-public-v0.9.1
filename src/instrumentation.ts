// Bootstrap фонового воркера (Next.js instrumentation). Вызывается при старте
// nodejs-рантайма; guard от повторного вызова при HMR в dev-режиме — внутри startWorker.
// Порядок важен:
//  1) восстановление после сброса песочницы (db-restore: секреты env.backup →
//     process.env/.env; подмена «свежей» БД снапшотом из /home/sync/db-backup) —
//     ДО любых запросов к БД, подменять файл под открытым коннектом нельзя;
//  2) самобутстрап БД (схема + стартовый админ): приложение обязано подниматься
//     в любом окружении (публикация платформы / standalone / чистый git);
//  3) фоновый воркер (в т.ч. периодический снапшот БД — db-backup).
// Ошибка любого шага НЕ роняет сервер (запросы продолжат работу, /api/health
// отразит деградацию и повторит попытку).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { restoreEnvSecrets, restoreDatabaseIfFresh } = await import('./lib/db-restore');
    restoreEnvSecrets();
    await restoreDatabaseIfFresh();
  } catch (err: unknown) {
    console.error('[instrumentation] восстановление из снапшота не выполнено (сервер продолжит работу):', err);
  }
  try {
    const { ensureDatabaseBootstrap } = await import('./lib/db-bootstrap');
    await ensureDatabaseBootstrap();
  } catch (err: unknown) {
    console.error('[instrumentation] бутстрап БД не завершён (сервер продолжит работу):', err);
  }
  const { startWorker } = await import('./lib/scheduler/worker');
  startWorker();
}
