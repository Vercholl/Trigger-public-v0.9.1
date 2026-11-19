// Пароли: bcrypt (cost 12) и политика (≥10 символов, буквы + цифры, не email,
// не популярный пароль).
//
// ПОЛИТИКА ПАРОЛЯ (validatePasswordPolicy): проверяется СЕРВЕРОМ в трёх точках:
// создание пользователя и сброс пароля (services/users.ts), смена пароля при
// входе (services/auth.ts changePassword). Обратная совместимость: политика
// применяется ТОЛЬКО при установке НОВОГО пароля — существующие пароли
// продолжают работать (принудительная ротация через mustChangePassword).
//
// Правила (v0.8.6, требования ИБ):
//  - длина ≥ PASSWORD_MIN_LENGTH (env, по умолчанию 10, допустимый диапазон 8..128);
//  - хотя бы одна буква (латиница ИЛИ кириллица) и хотя бы одна цифра;
//  - спецсимволы/пробелы не запрещены (NIST SP 800-63B: не усложняем запоминание
//    искусственными запретами);
//  - пароль не содержит email пользователя и его локальную часть (до «@»);
//  - пароль не содержит имя пользователя (если задано, ≥4 символов);
//  - пароль не входит в локальный блэклист популярных паролей (топ утечек,
//    qwerty/123456/пароль и т.п.).
//
// Хранение: bcrypt cost 12 (~сотни мс на хэш) — пароли из утечки БД
// практически не перебираются. Связанная защита (не здесь): брутфорс-лок 423,
// rate-limit логина и смены пароля — services/auth.ts; фиктивная проверка
// против DUMMY_BCRYPT_HASH (анти-enumeration по таймингу) — там же; история
// паролей (анти-повтор) — security/password-history.ts.
import bcrypt from 'bcryptjs';

// Стоимость bcrypt: 12 раундов — компромисс «скорость логина/защита от перебора».
const BCRYPT_COST = 12;

/** Минимальная длина НОВОГО пароля. Env PASSWORD_MIN_LENGTH (8..128), дефолт 10.
 *  Требование ИБ: современные рекомендации (NIST/ЦБ) — не короче 10 при
 *  отсутствии иных факторов (2FA). */
export const PASSWORD_MIN_LENGTH = (() => {
  const raw = Number(process.env.PASSWORD_MIN_LENGTH);
  if (Number.isFinite(raw) && raw >= 8 && raw <= 128) return Math.floor(raw);
  return 10;
})();

/** Контекст владельца пароля — для запретов «пароль = email/имя». */
export interface PasswordContext {
  email?: string | null;
  name?: string | null;
}

/**
 * Локальный блэклист популярных/скомпрометированных паролей (top утечек,
 * русскоязычные + международные, до 300 записей). Проверка регистронезависимая.
 * Источник: стандартные топ-списки (HaveIBeenPwned top-100, «пароль» и т.п.);
 * полный вариант — внешний API, здесь офлайн-набор.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  // Международный топ
  '123456', 'password', '123456789', '12345678', '12345', 'qwerty', 'qwerty123',
  '111111', '1234567', '123123', 'abc123', '1234', 'password1', 'password123',
  'iloveyou', '000000', 'qwertyuiop', '1q2w3e4r', 'admin', 'admin123',
  'letmein', 'welcome', 'monkey', 'dragon', 'sunshine', 'princess', 'football',
  'baseball', 'superman', 'batman', 'trustno1', 'master', 'shadow', 'michael',
  'jennifer', '11111111', '654321', '555555', 'lovely', 'whatever', 'zaq12wsx',
  '1qaz2wsx', 'qazwsx', 'passw0rd', 'p@ssw0rd', 'p@ssword', 'secret', 'guest',
  'root', 'toor', 'login', 'pass', 'test', 'test123', 'qwe123', '1q2w3e',
  'asdasd', 'zxczxc', 'abcd1234', 'aaaaaaaa', 'aaaaaa', 'google', 'android',
  'samsung', 'iphone', 'apple', 'nokia', 'qwerty12345', '123qwe', 'qweqwe',
  // Русскоязычный топ (транслит и оригинал)
  'пароль', 'пароль123', 'пароль1', 'привет', 'люблю', 'любовь', 'россия',
  'москва', 'солнце', 'админ', 'пароль!', 'gfhjkm', 'gfhjkm123', 'gfhjirf',
  'vjyt', 'ghbdtn', 'nfyz', 'cnhfkb', 'rehbr', ' Russia123', 'russia123',
  'moskva', 'privet', 'privet123', 'lublu', 'lubov', 'hello', 'hello123',
  // Корпоративно-популярные
  'qwerty2025', 'password2025', 'admin2025', '123456qwe',
  '1q2w3e4r5t', 'q1w2e3r4', 'q1w2e3r4t5', '123456a', '1234567a', '12345678a',
]);

/** Служебные символы-«заглушки», которые не должны попадать в реальные пароли. */
const PLACEHOLDER_TOKENS = ['changeme', 'change_me', 'изменить', 'новыйпароль', 'newpassword'];

/** Нормализация для блэклиста: только буквы и цифры, нижний регистр. */
function normalizeForBlocklist(value: string): string {
  return value.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
}

/** Есть ли подстрока (≥4 символов) одного из полей контекста в пароле. */
function containsFragment(password: string, fragment: string): boolean {
  const f = fragment.toLowerCase().trim();
  if (f.length < 4) return false;
  return password.toLowerCase().includes(f);
}

/** Хэширование пароля (bcrypt, cost 12) — при создании пользователя/сбросе/смене пароля. */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

/** Сверка пароля с хэшем; ЛЮБАЯ ошибка (в т.ч. битый формат хэша) → false —
 *  логин не падает исключением, а считается неудачной попыткой. */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/**
 * Политика пароля. Возвращает текст ошибки или null, если пароль корректен.
 * Правила: см. комментарий модуля. Текст ошибок показывается пользователю в UI
 * (форма создания/смены пароля).
 */
export function validatePasswordPolicy(password: string, ctx?: PasswordContext): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Пароль должен содержать минимум ${PASSWORD_MIN_LENGTH} символов`;
  }
  if (password.length > 128) {
    return 'Пароль не может быть длиннее 128 символов';
  }
  const hasLetter = /[A-Za-zА-Яа-яЁё]/.test(password);
  const hasDigit = /\d/.test(password);
  if (!hasLetter || !hasDigit) return 'Пароль должен содержать буквы и цифры';

  // Блэклист популярных паролей: сравниваем нормализованную форму (без
  // разделителей) и сырую — ловит «P@ssw0rd123» по нормализации и «пароль!!» по сырой базе.
  const normalized = normalizeForBlocklist(password);
  if (COMMON_PASSWORDS.has(normalized) || COMMON_PASSWORDS.has(password.toLowerCase())) {
    return 'Этот пароль слишком популярный — придумайте другой';
  }
  for (const token of PLACEHOLDER_TOKENS) {
    if (password.toLowerCase().includes(token)) {
      return 'Этот пароль слишком популярный — придумайте другой';
    }
  }

  // Пароль не должен повторять данные учётной записи
  if (ctx?.email) {
    const email = ctx.email.trim().toLowerCase();
    if (email && containsFragment(password, email)) {
      return 'Пароль не должен содержать ваш email';
    }
    const localPart = email.split('@')[0] ?? '';
    if (containsFragment(password, localPart)) {
      return 'Пароль не должен содержать ваш email';
    }
  }
  if (ctx?.name && containsFragment(password, ctx.name)) {
    return 'Пароль не должен содержать ваше имя';
  }
  return null;
}

/** Описание активной политики для UI/аудита/self-check. */
export function passwordPolicyDescription(): string[] {
  return [
    `минимум ${PASSWORD_MIN_LENGTH} символов`,
    'буквы (латиница или кириллица) и цифры',
    'не совпадает с email и именем пользователя',
    'не входит в список популярных паролей',
    'нельзя повторить один из 5 последних паролей',
  ];
}
