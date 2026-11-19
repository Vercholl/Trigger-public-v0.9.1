// Шифрование секретов провайдеров при хранении в БД (AES-256-GCM).
// Защищает токен SMS.Tech и логин/пароль Т2 от чтения при утечке/копии файла
// базы (бэкапы, архивы, случайный доступ): в БД лежит «enc:v1:…», ключ —
// только в окружении сервера. В панель секреты не возвращаются в любом виде.
//
// Устойчивость к смене ключа (в этой среде .env переживал платформенные
// откаты): ключ выводится каскадом SECRETS_KEY → SESSION_SECRET →
// UNSUBSCRIBE_SECRET → фиксированный фолбэк (с предупреждением в лог).
// Если расшифровать не удалось (ключ изменился) — секрет считается
// потерянным и ведёт себя как пустой: панель попросит ввести заново,
// ошибка не валит отправку/чтение карточек.
//
// Значения БЕЗ префикса «enc:v1:» трактуются как легаси-plaintext
// (сохранены до внедрения шифрования) и возвращаются как есть — при
// следующем сохранении из панели перезапишутся уже зашифрованными.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
/** Фиксированная соль вывода ключа: детерминизм переживает перезапуски.
 *  Нейтральное имя с v0.9.1 (де-branding): зашифрованных значений под прежней
 *  солью не существовало — данных для миграции нет; при ошибке расшифровки
 *  decryptSecret и так ведёт себя как «секрет потерян, ввести заново»
 *  (см. шапку модуля). */
const KEY_SALT = 'trigger:secrets:v1';
/** Последний фолбэк — защита «хоть какая-то» для сред без секретов в env. */
const FALLBACK_PASSPHRASE = 'trigger:local-development-only';

let cachedKey: Buffer | null = null;
let fallbackWarned = false;

function resolveKey(): Buffer {
  if (cachedKey) return cachedKey;
  const passphrase =
    (process.env.SECRETS_KEY ?? '').trim() ||
    (process.env.SESSION_SECRET ?? '').trim() ||
    (process.env.UNSUBSCRIBE_SECRET ?? '').trim() ||
    FALLBACK_PASSPHRASE;
  if (passphrase === FALLBACK_PASSPHRASE && !fallbackWarned) {
    fallbackWarned = true;
    console.warn(
      '[secrets] SECRETS_KEY/SESSION_SECRET/UNSUBSCRIBE_SECRET не заданы — ключ шифрования выведен из фиксированного фолбэка; задайте SECRETS_KEY в .env',
    );
  }
  cachedKey = scryptSync(passphrase, KEY_SALT, 32);
  return cachedKey;
}

/** Зашифровать секрет для записи в БД. Пустая строка остаётся пустой. */
export function encryptSecret(plain: string): string {
  if (plain === '') return '';
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, resolveKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

/**
 * Расшифровать секрет из БД. Легаси-plaintext (без префикса) — как есть;
 * при ошибке расшифровки (ключ сменился/данные повреждены) — пустая строка
 * и предупреждение: панель попросит сохранить секрет заново.
 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  try {
    const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split('.');
    if (!ivB64 || !tagB64 || !ctB64) throw new Error('неверный формат');
    const decipher = createDecipheriv(ALGO, resolveKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]);
    return pt.toString('utf8');
  } catch {
    console.warn('[secrets] не удалось расшифровать секрет (ключ изменён?) — значение сброшено, введите заново');
    return '';
  }
}

/** Маска для безопасного показа факта сохранения: «••••••••9f2c». */
export function maskSecret(value: string): string {
  if (value.length <= 4) return '••••';
  return `••••••••${value.slice(-4)}`;
}

/** Маска логина: первые 3 символа + «…» (логин не секрет целиком, но не светим). */
export function maskLogin(value: string): string {
  if (value.length <= 3) return `${value[0] ?? ''}•••`;
  return `${value.slice(0, 3)}•••`;
}

/** Сравнение строк за постоянное время (анти-тайминг-атака): сравниваем
 *  sha256-хеши фиксированной длины — не раскрывается ни длина, ни содержимое.
 *  Пустые строки никогда не равны. */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
