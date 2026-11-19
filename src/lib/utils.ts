// Общие утилиты фронтенда. Слой: изоморфные хелперы (работают и на клиенте,
// и в серверных компонентах). cn() — основа всех shadcn/ui-компонентов
// (src/components/ui/**): слияние Tailwind-классов без конфликтов дубликатов;
// используется и презентационными компонентами панели (logo, app-shell, views).
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/** Слияние классов: clsx собирает условные классы/массивы в строку,
 * tailwind-merge разрешает конфликты Tailwind-утилит (поздний побеждает:
 * cn("p-2", "p-4") → "p-4") — базовый хелпер className во всём UI.
 * @param inputs классы, условные выражения и массивы (см. ClassValue)
 * @returns итоговая строка классов */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
