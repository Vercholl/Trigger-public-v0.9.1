// Регистрация «полей доработок системы данных» (ч.1–4) как кастомных полей (G4).
// Идемпотентно: существующие ключи пропускаются (не перезаписываются — чужие
// настройки/деактивации не трогаем). Запуск: bun scripts/register-core-fields.ts
// (те же поля на свежих развёртываниях регистрирует db-bootstrap.ts).
// После регистрации: переменные {{cf_<key>}} в шаблонах, правила сегментов,
// приём значений из client_card (все написания системы данных, включая isSravni_client).
import { PrismaClient } from '@prisma/client';
import { CORE_CF_SEED } from '../src/lib/registry/core-cf-seed';

const db = new PrismaClient();

async function main(): Promise<void> {
  let created = 0;
  let skipped = 0;
  for (const seed of CORE_CF_SEED) {
    const existing = await db.customField.findUnique({ where: { key: seed.key } });
    if (existing) {
      skipped += 1;
      console.log(`  = ${seed.key} (уже зарегистрировано, ${existing.isActive ? 'активно' : 'деактивировано'})`);
      continue;
    }
    await db.customField.create({
      data: {
        key: seed.key,
        label: seed.label,
        type: seed.type,
        description: seed.description,
        isActive: true,
      },
    });
    created += 1;
    console.log(`  + ${seed.key} (${seed.type}) — ${seed.label}`);
  }
  console.log(`\nИтог: создано ${created}, пропущено ${skipped} (из ${CORE_CF_SEED.length} полей реестра доработок).`);
  console.log('Переменная шаблона: {{cf_<key>}}; приём из client_card: cf_<key> / <key> / camelCase / isSravni_client.');
}

main()
  .catch((e) => {
    console.error('register-core-fields failed:', e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
