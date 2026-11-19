// Регенерация встроенного DDL для src/lib/db-bootstrap.ts после изменений
// prisma/schema.prisma. Запуск: bun scripts/gen-bootstrap-ddl.ts
//
// Что делает:
//  1) bunx prisma migrate diff --from-empty --to-schema-datamodel → SQL пустой схемы;
//  2) CREATE TABLE/INDEX → IF NOT EXISTS, вычищаются комментарии/PRAGMA;
//  3) полученные statements печатаются в stdout в виде JS-массива — вставьте их
//     в константу SCHEMA_DDL в src/lib/db-bootstrap.ts вместо старой.
// Скрипт НЕ редактирует файлы автоматически (осознанная правка + ревью).
import { execSync } from 'node:child_process';

const sql = execSync(
  'bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script',
  { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' },
);

const lines = sql
  .split('\n')
  .filter((l) => l.trim() && !l.trim().startsWith('--') && !l.trim().toUpperCase().startsWith('PRAGMA'));
let cleaned = lines.join('\n');
cleaned = cleaned
  .replace(/CREATE TABLE "/g, 'CREATE TABLE IF NOT EXISTS "')
  .replace(/CREATE UNIQUE INDEX "/g, 'CREATE UNIQUE INDEX IF NOT EXISTS "')
  .replace(/CREATE INDEX "(?!(?: IF NOT EXISTS)")/g, 'CREATE INDEX IF NOT EXISTS "');

const stmts = cleaned
  .split(';\n')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => (s.endsWith(';') ? s : `${s};`));

console.log(`// Сгенерировано scripts/gen-bootstrap-ddl.ts (${new Date().toISOString()})`);
console.log('// Вставьте ниже вместо текущей константы SCHEMA_DDL в src/lib/db-bootstrap.ts:');
console.log(JSON.stringify(stmts, null, 2));
