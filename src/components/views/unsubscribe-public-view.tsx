'use client';

// ПУБЛИЧНАЯ страница отписки из SMS (без входа в панель): рендерится входной
// точкой page.tsx по ?u={код} (короткая ссылка) или ?unsub={токен} (полная,
// легаси). Домен: unsubscribe. API: GET/POST /api/v1/u?c= и /api/v1/unsubscribe?t=
// (rate-limit на сервере). GET проверяет ссылку (маскированный номер +
// рекламодатель), POST исполняет отписку идемпотентно — сервисные SMS
// (напоминания о платежах) клиенту продолжают приходить.
// Роли: без авторизации — подпись HMAC в токене/неугадываемый код и есть
// авторизация; ошибки сети/битая ссылка — состояние «Ссылка недействительна».
import * as React from 'react';
import { CircleCheck, CircleX, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { TriggerMark } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api-client';

interface UnsubInfo {
  ok: boolean;
  phone?: string;
  advertiser?: string;
  title?: string;
}

/** ?u={код} — короткая ссылка (?c= в API), ?unsub={токен} — полная (t=). */
export function UnsubscribePublicView({ token, shortCode }: { token?: string; shortCode?: string }) {
  const linkParam = shortCode ?? token ?? '';
  const apiUrl = shortCode
    ? `/api/v1/u?c=${encodeURIComponent(linkParam)}`
    : `/api/v1/unsubscribe?t=${encodeURIComponent(linkParam)}`;
  const [status, setStatus] = React.useState<'loading' | 'invalid' | 'ready' | 'done'>('loading');
  const [info, setInfo] = React.useState<UnsubInfo | null>(null);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    api<UnsubInfo>(apiUrl)
      .then((res) => {
        if (cancelled) return;
        if (res && res.ok) {
          setInfo(res);
          setStatus('ready');
        } else {
          setStatus('invalid');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('invalid');
      });
    return () => {
      cancelled = true;
    };
  }, [apiUrl]);

  async function doUnsubscribe() {
    setPending(true);
    try {
      // Параметр в query (контракт публичного API), а не в теле.
      const res = await api<{ ok: boolean; phone?: string }>(apiUrl, { method: 'POST' });
      if (res.ok) {
        setStatus('done');
        setInfo((prev) => (prev ? { ...prev, phone: res.phone ?? prev.phone } : prev));
      } else {
        setStatus('invalid');
      }
    } catch {
      toast.error('Ошибка: не удалось выполнить отписку, попробуйте позже');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-muted px-4 py-8 dark:bg-background">
      <div className="w-full max-w-md">
        <Card className="shadow-sm">
          <CardContent className="p-6">
            <div className="mb-6 flex flex-col items-center gap-3 text-center">
              <TriggerMark className="size-12 rounded-xl shadow-sm" title="Trigger" />
              <h1 className="text-lg font-bold text-foreground">Отписка от рекламных SMS</h1>
            </div>

            {status === 'loading' ? (
              <div className="flex flex-col items-center gap-3 py-8 text-zinc-500 dark:text-zinc-400">
                <Loader2 className="size-8 animate-spin text-zinc-400" aria-hidden />
                <p className="text-sm">Проверяем ссылку…</p>
              </div>
            ) : null}

            {status === 'invalid' ? (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <CircleX className="size-12 text-red-500 dark:text-red-400" aria-hidden />
                <p className="font-medium text-foreground">Ссылка недействительна или истекла</p>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  Запросите новую ссылку из SMS или обратитесь в поддержку
                </p>
              </div>
            ) : null}

            {status === 'ready' ? (
              <div className="space-y-5">
                <div className="text-center">
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">Отписаться от рекламных сообщений?</p>
                  <p className="mt-2 font-mono text-2xl font-semibold tracking-wide text-foreground">
                    {info?.phone ?? '—'}
                  </p>
                  {info?.advertiser ? (
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{info.advertiser}</p>
                  ) : null}
                  <p className="mt-3 text-xs text-zinc-400">
                    Сервисные сообщения по договору (напоминания о платежах) будут приходить как
                    раньше
                  </p>
                </div>
                <Button
                  className="w-full bg-emerald-600 text-white hover:bg-emerald-700"
                  onClick={doUnsubscribe}
                  disabled={pending}
                >
                  {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                  Отписаться от рекламы
                </Button>
              </div>
            ) : null}

            {status === 'done' ? (
              <div className="flex flex-col items-center gap-3 py-4 text-center">
                <CircleCheck className="size-12 text-emerald-600 dark:text-emerald-400" aria-hidden />
                <p className="font-medium text-foreground">
                  Готово! Номер {info?.phone ?? ''} отписан от рекламы
                </p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Рекламные сообщения больше не будут приходить. Сервисные сообщения по
                  договору (напоминания о платеже, статусы заявок, коды) будут отправляться в
                  соответствии с условиями договора.
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
        <p className="mt-4 text-center text-xs text-zinc-400">Powered by Trigger</p>
      </div>
    </main>
  );
}
