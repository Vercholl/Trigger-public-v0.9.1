// Debounce значения для поисковых полей панели (400 мс — типовой интервал:
// не дёргаем API на каждый символ). Единственная реализация — до v0.7.2
// один и тот же хук копипастился в пять вьюх (clients/events/sms-log/
// delivery-events/unsubscribed) с риском расползания семантики.
// Использование: const search = useDebounced(searchInput, 400).
'use client';

import React from 'react';

/** Возвращает копию value, обновляемую не чаще раза в `delay` мс. */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
