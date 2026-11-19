'use client';

// Эмблема Trigger: скруглённый квадрат с изумрудным градиентом и белой молнией
// (импульс события) + сигнальные дуги (коммуникация). Используется в сайдбаре,
// на экране входа и в публичной отписке; тот же SVG служит фавиконом (src/app/icon.svg).
// Слой: чистый презентационный компонент без состояния и запросов.

import * as React from 'react';
import { cn } from '@/lib/utils';

/** Эмблема Trigger (чистый SVG, без картинок-ассетов). React.useId даёт
 * уникальный суффикс id градиента — при нескольких экземплярах на странице
 * <defs> с одинаковым id конфликтовали бы (градиент «протекал» из первого). */
export function TriggerMark({ className, title }: { className?: string; title?: string }) {
  const uid = React.useId().replace(/[:]/g, '');
  const gradId = `tg-${uid}`;
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label={title ?? 'Trigger'}
      className={cn('shrink-0', className)}
    >
      <defs>
        <linearGradient id={gradId} x1="8" y1="4" x2="40" y2="44" gradientUnits="userSpaceOnUse">
          <stop stopColor="#34d399" />
          <stop offset="0.55" stopColor="#10b981" />
          <stop offset="1" stopColor="#0f766e" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="12" fill={`url(#${gradId})`} />
      {/* стеклянный блик сверху */}
      <path d="M4 14a10 10 0 0 1 10-10h20a10 10 0 0 1 10 10v1c-6.5-3.4-13-5-20-5S10.5 11.6 4 15z" fill="#ffffff" fillOpacity="0.10" />
      {/* сигнальные дуги — «волна» коммуникации */}
      <path d="M10.5 20.5a8.5 8.5 0 0 1 8.5-8.5" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M10.5 26.5a14.5 14.5 0 0 1 14.5-14.5" stroke="#ffffff" strokeOpacity="0.22" strokeWidth="2.6" strokeLinecap="round" />
      {/* молния-импульс */}
      <path d="M28.6 9.4 15.6 27.2h7.1L20.4 38.6 34.4 20.2h-7.6z" fill="#ffffff" />
    </svg>
  );
}

/** Эмблема + название. Тёмный вариант — для сайдбара/логина. */
export function TriggerLogo({
  compact = false,
  name = 'Trigger',
  subtitle = 'Триггерные SMS компании',
}: {
  compact?: boolean;
  name?: string;
  subtitle?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <TriggerMark className={compact ? 'size-8' : 'size-9'} />
      <div className="min-w-0">
        <p className="truncate text-sm font-bold tracking-tight text-white">{name}</p>
        <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>
      </div>
    </div>
  );
}
