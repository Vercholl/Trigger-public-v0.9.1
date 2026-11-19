// Лимит размера тела запроса на публичных приёмниках (анти-DoS).
//
// ЗАЧЕМ: route-handler'ы Next.js App Router читают req.json() БЕЗ ограничения
// размера — легитимный лимит «батч ≤ 5000 событий» проверяется ПОСЛЕ полного
// разбора тела. Злоумышленник (даже без секрета — rate-limit 300/мин пропускает
// запросы) мог бы слать мегабайтные JSON-ы, монополизируя память/циклы CPU на
// парсинге. Двухуровневая защита:
//  1) Content-Length заголовок → ранний 413 ДО чтения тела (заявленный размер
//     уже превышает лимит; заголовок обязателен для тел с телом запроса);
//  2) фактическая длина прочитанного текста → 413 (обход через ложный
//     Content-Length / chunked-передачу).
//
// Для панельных (авторизованных) роутов лимит менее критичен — там действует
// zod-валидация после разбора и аутентификация до разбора; публичные приёмники
// ограничиваем все: hooks/events (5 МБ — батчи внешней платформы), events
// (2 МБ — одиночные события с карточкой клиента), webhook-и (2 МБ — батчи
// статусов до 1000 элементов укладываются с запасом).

import type { NextRequest } from 'next/server';
import { ApiError } from '@/lib/api';

/** Разбирает JSON-тело с ограничением размера. Бросает ApiError:
 *  413 (тело больше лимита — до/после чтения), 400 (мусорный JSON). */
export async function readJsonBounded(req: NextRequest, maxBytes: number): Promise<unknown> {
  // Уровень 1: заявленный размер — отбой до чтения тела
  const declared = req.headers.get('content-length');
  if (declared !== null) {
    const n = Number.parseInt(declared, 10);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new ApiError(413, 'Тело запроса слишком большое', `Лимит: ${maxBytes} байт`);
    }
  }
  // Уровень 2: фактическая длина прочитанного текста (чанками Content-Length не обманешь)
  const text = await req.text();
  if (text.length > maxBytes) {
    throw new ApiError(413, 'Тело запроса слишком большое', `Лимит: ${maxBytes} байт`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'Некорректное тело запроса', 'Ожидается корректный JSON');
  }
}

/** Читает тело как текст с ограничением размера (для не-JSON приёмников). */
export async function readTextBounded(req: NextRequest, maxBytes: number): Promise<string> {
  const declared = req.headers.get('content-length');
  if (declared !== null) {
    const n = Number.parseInt(declared, 10);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new ApiError(413, 'Тело запроса слишком большое', `Лимит: ${maxBytes} байт`);
    }
  }
  const text = await req.text();
  if (text.length > maxBytes) {
    throw new ApiError(413, 'Тело запроса слишком большое', `Лимит: ${maxBytes} байт`);
  }
  return text;
}
