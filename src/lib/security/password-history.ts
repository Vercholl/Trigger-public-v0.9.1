// История паролей: запрет повторного использования (анти-ротация A→B→A).
// Требование ИБ: новый пароль не должен совпадать с текущим и PASSWORD_HISTORY_DEPTH
// последних паролей. Хранятся bcrypt-хеши (утечка БД не раскрывает пароли).
// Проверка — bcrypt.compare по каждому хешу (медленно ~300 мс/хеш — осознанно,
// смена пароля не hot-path; дополнительно замедляет офлайн-перебор).
import { db } from '@/lib/db';
import { verifyPassword } from '@/lib/security/password';

/** Глубина истории: сколько последних паролей запрещено повторять. */
export const PASSWORD_HISTORY_DEPTH = 5;

export interface PasswordReuseCheck {
  reused: boolean;
  /** Где совпало: 'current' | 'history' | null. */
  matchedIn: 'current' | 'history' | null;
}

/**
 * Проверка повтора пароля: сверяет кандидата с текущим хешем пользователя и
 * последними PASSWORD_HISTORY_DEPTH хешами истории. НЕ пишет ничего в БД.
 */
export async function checkPasswordNotReused(
  userId: string,
  currentPasswordHash: string,
  newPassword: string,
): Promise<PasswordReuseCheck> {
  if (await verifyPassword(newPassword, currentPasswordHash)) {
    return { reused: true, matchedIn: 'current' };
  }
  const history = await db.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: PASSWORD_HISTORY_DEPTH,
    select: { passwordHash: true },
  });
  for (const h of history) {
    if (await verifyPassword(newPassword, h.passwordHash)) {
      return { reused: true, matchedIn: 'history' };
    }
  }
  return { reused: false, matchedIn: null };
}

/**
 * Запись в историю: вызывается ПОСЛЕ успешной установки нового пароля с хешем
 * ПРЕДЫДУЩЕГО пароля (чтобы «вернуть старый» блокировался). Подрезает хвост
 * глубины: храним не более PASSWORD_HISTORY_DEPTH записей.
 */
export async function recordPreviousPassword(
  userId: string,
  previousPasswordHash: string,
): Promise<void> {
  try {
    // Дедуп: тот же хеш уже в истории (например, «текущий» раньше уже писался)
    const existing = await db.passwordHistory.findFirst({
      where: { userId, passwordHash: previousPasswordHash },
      select: { id: true },
    });
    if (!existing) {
      await db.passwordHistory.create({ data: { userId, passwordHash: previousPasswordHash } });
    }
    // Подрезка: оставляем только последние N (по createdAt)
    const all = await db.passwordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: PASSWORD_HISTORY_DEPTH + 1,
      select: { id: true },
    });
    if (all.length > PASSWORD_HISTORY_DEPTH) {
      const idsToRemove = all.slice(PASSWORD_HISTORY_DEPTH).map((r) => r.id);
      await db.passwordHistory.deleteMany({ where: { id: { in: idsToRemove } } });
    }
  } catch (e) {
    // Fail-soft: история — дополнительная защита, её сбой не должен валить
    // смену пароля (запись уже применена). Причина видна в логе процесса.
    console.error('[password-history] write failed:', e instanceof Error ? e.message : String(e));
  }
}
