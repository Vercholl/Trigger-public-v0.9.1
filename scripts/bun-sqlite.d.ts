// Типы bun:sqlite для нагрузочных скриптов (scripts/loadtest-seed.ts,
// scripts/loadtest-bench.ts). Bun подставляет модуль в рантайме; tsc без
// bun-types не знает деклараций — описываем используемое подмножество API.
declare module 'bun:sqlite' {
  export class Statement {
    run(...params: unknown[]): unknown;
  }
  export class Query {
    get(...params: unknown[]): unknown;
  }
  export class Database {
    constructor(path: string, options?: { readonly?: boolean });
    exec(sql: string): unknown;
    prepare(sql: string): Statement;
    query(sql: string): Query;
    transaction(fn: () => void): () => void;
    close(): void;
  }
}
