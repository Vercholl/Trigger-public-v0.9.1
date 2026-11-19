'use client';

// Экран «Клиенты»: таблица клиентской базы (карточка клиента) с поиском и фильтрами,
// добавление/редактирование, импорт CSV и карточка клиента (профиль + история SMS).
// Домен: клиентская база рассылок — согласия, отписка, часовой пояс, поля карточки клиента.
// API: GET/POST /api/v1/clients, PUT/DELETE /api/v1/clients/{id},
// POST /api/v1/clients/import (CSV), GET /api/v1/clients/{id}/messages (история + stats).
// Экран открывают все роли; мутации (добавить/импорт/правка/удаление) — под ViewerGuard.

import * as React from 'react';
import { Briefcase, CalendarClock, Eye, History, FileText, Layers, MessageSquare, Pencil, Plus, Search, Send, Shapes, Trash2, Upload, UserRound } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api-client';
import { useDebounced } from '@/lib/hooks/use-debounced';
import {
  invalidatePanel,
  AgreementStatusBadge,
  clientFullName,
  ConsentBadge,
  CONSENT_META,
  EmptyState,
  ErrorState,
  fmtDT,
  fmtDate,
  formatProfileHistoryValue,
  relTime,
  MassUpdateStatusBadge,
  PROVIDER_LABELS,
  profileHistoryFieldLabel,
  PROFILE_FIELD_CREATED,
  PROFILE_SOURCE_META,
  REJECT_REASON_TEXT,
  ProductBadge,
  SmsBadge,
  SmsVarsSnapshot,
  TablePagination,
  TIMEZONES,
  timezoneOptionLabel,
  ViewerGuard,
  useCustomFields,
  CF_TYPE_META,
  type ClientItem,
  type ConsentStatus,
  type ImportResult,
  type MassUpdateJobItem,
  type MassUpdateStatus,
  type Paged,
  type ProfileChangeItem,
  type SmsMessage,
} from '@/components/views/shared';

// Служебное значение селекта «Другая…» — включает ручной ввод IANA-имени/смещения
const OTHER_TZ = '__other__';
/** Валидация формы клиента: телефон 10–15 цифр с опциональным «+»;
 *  INT_RE — целое ≥ 0 (счётчики, статусы, ID); DECIMAL_RE — деньги («,» или «.»).
 *  Границы PHONE_RE — E.164-подобные: ≤15 цифр вместе с кодом страны (лимит ITU),
 *  ≥10 отсекает неполные номера без кода страны. Нормализации на клиенте нет:
 *  форма шлёт телефон как есть (trim), в E.164 его приводит сервер
 *  (normalizePhone в services/clients — чистит пробелы/дефисы/скобки, добавляет
 *  «+»); эта проверка — лишь UI-гвард от опечаток, финальное слово за 422 API. */
const PHONE_RE = /^\+?\d{10,15}$/;
const INT_RE = /^\d+$/;
const DECIMAL_RE = /^\d+([.,]\d+)?$/;

/** Невалидное числовое поле (пустое — валидно). */
function numInvalid(v: string, allowDecimal = false): boolean {
  const t = v.trim();
  if (t.length === 0) return false;
  return allowDecimal ? !DECIMAL_RE.test(t) : !INT_RE.test(t);
}


/* ============================ Диалог добавления/редактирования ============================ */

/** Секция карточки — заголовок с иконкой + сетка полей. */
function CardSection({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: typeof UserRound;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {hint ? <span className="text-xs text-zinc-400">{hint}</span> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </section>
  );
}

/** Числовое поле формы: живая валидация numInvalid (пустое = значение не задано, валидно). */
function NumberField({
  id,
  label,
  value,
  onChange,
  placeholder,
  allowDecimal,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  allowDecimal?: boolean;
}) {
  const invalid = numInvalid(value, allowDecimal);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={allowDecimal ? 'decimal' : 'numeric'}
        aria-invalid={invalid}
      />
      {invalid ? (
        <p className="text-xs text-red-600 dark:text-red-400">
          {allowDecimal ? 'Только неотрицательное число' : 'Только целое неотрицательное число'}
        </p>
      ) : null}
    </div>
  );
}

/** Поле-дата (input type=date); в API уходит как ISO (см. buildCardBody → date()). */
function DateField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** Диалог добавления/редактирования клиента: карточка клиента по секциям
 *  (Профиль / Заявка / Договор / Преапрув) + доп. JSON + согласие на SMS.
 *  client = null → создание (externalId вводится здесь), иначе правка (externalId залочен). */
function ClientDialog({
  open,
  onOpenChange,
  client,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: ClientItem | null;
}) {
  const queryClient = useQueryClient();

  // Контакты
  const [externalId, setExternalId] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [timezone, setTimezone] = React.useState('Europe/Moscow');
  const [otherTz, setOtherTz] = React.useState('');
  const [consent, setConsent] = React.useState<ConsentStatus>('NONE');
  const [consentSource, setConsentSource] = React.useState('');
  const [extraJson, setExtraJson] = React.useState('');

  // Профиль (карточка)
  const [firstName, setFirstName] = React.useState('');
  const [lastName, setLastName] = React.useState('');
  const [middleName, setMiddleName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [birthday, setBirthday] = React.useState('');
  const [product, setProduct] = React.useState('');
  const [agreementsLastYear, setAgreementsLastYear] = React.useState('');
  const [agreementsLifetime, setAgreementsLifetime] = React.useState('');
  const [banDays, setBanDays] = React.useState('');
  const [notificationActive, setNotificationActive] = React.useState(true);

  // Заявка
  const [appId, setAppId] = React.useState('');
  const [appStatus, setAppStatus] = React.useState('');
  const [appPrevStatus, setAppPrevStatus] = React.useState('');

  // Договор
  const [agrId, setAgrId] = React.useState('');
  const [agrStatus, setAgrStatus] = React.useState('');
  const [agrPrevStatus, setAgrPrevStatus] = React.useState('');
  const [loanAmount, setLoanAmount] = React.useState('');
  const [loanPeriod, setLoanPeriod] = React.useState('');
  const [loanClosed, setLoanClosed] = React.useState('');

  // Преапрув
  const [offerStart, setOfferStart] = React.useState('');
  const [offerExpired, setOfferExpired] = React.useState('');
  const [offerMoney, setOfferMoney] = React.useState('');
  const [offerDays, setOfferDays] = React.useState('');
  const [offerAvailable, setOfferAvailable] = React.useState('');

  const [jsonError, setJsonError] = React.useState<string | null>(null);
  const [serverError, setServerError] = React.useState<string | null>(null);

  // Кастомные поля профиля (динамический реестр ADMIN): значения в карточке —
  // строковые представления для инпутов (bool — 'yes'/'no'/'', date — YYYY-MM-DD).
  // Полная карточка (customFields) догружается GET /clients/{id} — в списке её нет.
  const cfQuery = useCustomFields();
  const cfFields = cfQuery.data?.items ?? [];
  const [cfDrafts, setCfDrafts] = React.useState<Record<string, string>>({});
  const fullClientQuery = useQuery({
    queryKey: ['client-full', client?.id],
    enabled: open && client !== null,
    queryFn: () => api<ClientItem>(`/api/v1/clients/${client!.id}`),
    staleTime: 30_000,
  });
  /** Полная карточка (с customFields) или строка списка как фолбэк. */
  const fullClient = fullClientQuery.data ?? client;
  /** Признак «CF-черновики заполнены из полной карточки» — сбрасывается на открытие
   *  (не затирает ввод оператора догрузкой). */
  const cfFilledRef = React.useRef(false);

  // Заполнение формы при открытии: из карточки клиента (правка) или дефолты (создание).
  // toDateInput обрезает ISO-дату до YYYY-MM-DD для input type=date.
  React.useEffect(() => {
    if (!open) return;
    setServerError(null);
    setJsonError(null);
    const toDateInput = (s: string | null): string => (s ? s.slice(0, 10) : '');
    if (client) {
      setExternalId(client.externalId);
      setPhone(client.phone);
      const knownTz = TIMEZONES.includes(client.timezone) ? client.timezone : OTHER_TZ;
      setTimezone(knownTz);
      setOtherTz(knownTz === OTHER_TZ ? client.timezone : '');
      setConsent(client.smsConsentStatus);
      setConsentSource(client.smsConsentSource ?? '');
      const rest = { ...(client.data ?? {}) };
      delete rest.name;
      setExtraJson(Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : '');
      // Карточка клиента
      setFirstName(client.client_first_name ?? '');
      setLastName(client.client_last_name ?? '');
      setMiddleName(client.client_middle_name ?? '');
      setEmail(client.email ?? '');
      setBirthday(toDateInput(client.person_birthday));
      setProduct(client.last_product_type ?? '');
      setAgreementsLastYear(client.agreements_for_lastyear !== null ? String(client.agreements_for_lastyear) : '');
      setAgreementsLifetime(client.agreements_for_lifetime !== null ? String(client.agreements_for_lifetime) : '');
      setBanDays(client.ban_days !== null ? String(client.ban_days) : '');
      setNotificationActive(client.notification_active);
      setAppId(client.application_id !== null ? String(client.application_id) : '');
      setAppStatus(client.application_actual_status !== null ? String(client.application_actual_status) : '');
      setAppPrevStatus(client.application_previous_status !== null ? String(client.application_previous_status) : '');
      setAgrId(client.agreement_id !== null ? String(client.agreement_id) : '');
      setAgrStatus(client.agreement_actual_status !== null ? String(client.agreement_actual_status) : '');
      setAgrPrevStatus(client.agreement_previous_status !== null ? String(client.agreement_previous_status) : '');
      setLoanAmount(client.loan_amount !== null ? String(client.loan_amount) : '');
      setLoanPeriod(client.loan_period !== null ? String(client.loan_period) : '');
      setLoanClosed(toDateInput(client.loan_closed_date));
      setOfferStart(toDateInput(client.person_offer_date_start));
      setOfferExpired(toDateInput(client.person_offer_date_expired));
      setOfferMoney(client.person_offer_approve_money !== null ? String(client.person_offer_approve_money) : '');
      setOfferDays(client.person_offer_approve_days !== null ? String(client.person_offer_approve_days) : '');
      setOfferAvailable(
        client.person_offer_available === null ? '' : client.person_offer_available ? 'yes' : 'no',
      );
    } else {
      setExternalId('');
      setPhone('');
      setTimezone('Europe/Moscow');
      setOtherTz('');
      setConsent('NONE');
      setConsentSource('');
      setExtraJson('');
      setFirstName('');
      setLastName('');
      setMiddleName('');
      setEmail('');
      setBirthday('');
      setProduct('');
      setAgreementsLastYear('');
      setAgreementsLifetime('');
      setBanDays('');
      setNotificationActive(true);
      setAppId('');
      setAppStatus('');
      setAppPrevStatus('');
      setAgrId('');
      setAgrStatus('');
      setAgrPrevStatus('');
      setLoanAmount('');
      setLoanPeriod('');
      setLoanClosed('');
      setOfferStart('');
      setOfferExpired('');
      setOfferMoney('');
      setOfferDays('');
      setOfferAvailable('');
    }
    // CF-черновики сбрасываются здесь; значения подтянет отдельный эффект ниже
    setCfDrafts({});
    cfFilledRef.current = false;
  }, [open, client]);

  // CF-значения — из ПОЛНОЙ карточки (GET /clients/{id}, в списке customFields нет).
  // Заполняются один раз на открытие (флаг — не затирает ввод оператора догрузкой);
  // даты «дд.мм.гггг» → YYYY-MM-DD для input type=date, булевы → yes/no.
  React.useEffect(() => {
    if (!open || cfFilledRef.current) return;
    const cfValues = fullClient?.customFields;
    if (cfValues === undefined) return; // полная карточка ещё грузится
    cfFilledRef.current = true;
    const cf: Record<string, string> = {};
    for (const f of cfFields) {
      const v = cfValues[f.key];
      if (v === undefined || v === null) continue;
      if (f.type === 'date') {
        const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(v));
        cf[f.key] = m ? `${m[3]}-${m[2]}-${m[1]}` : '';
      } else if (f.type === 'bool') {
        cf[f.key] = v === true ? 'yes' : 'no';
      } else {
        cf[f.key] = String(v);
      }
    }
    setCfDrafts(cf);
  }, [open, fullClient, cfFields]);

  const phoneInvalid = phone.trim().length > 0 && !PHONE_RE.test(phone.trim());
  // Итоговый часовой пояс: пункт списка либо ручной ввод при «Другая…»
  const finalTz = timezone === OTHER_TZ ? otherTz.trim() : timezone;

  // Сводная валидация числовых полей: целые (счётчики/статусы/ID) и деньги (allowDecimal)
  const numberInvalid =
    numInvalid(agreementsLastYear) ||
    numInvalid(agreementsLifetime) ||
    numInvalid(banDays) ||
    numInvalid(appId) ||
    numInvalid(appStatus) ||
    numInvalid(appPrevStatus) ||
    numInvalid(agrId) ||
    numInvalid(agrStatus) ||
    numInvalid(agrPrevStatus) ||
    numInvalid(loanPeriod) ||
    numInvalid(offerDays) ||
    numInvalid(loanAmount, true) ||
    numInvalid(offerMoney, true);

  /**
   * Карточка → поля верхнего уровня. Непустые значения отправляются;
   * при редактировании поля, которые БЫЛИ заполнены, а теперь очищены → null (очистка).
   */
  function buildCardBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    const text = (key: string, value: string, original: string | null): void => {
      const v = value.trim();
      if (v !== '') body[key] = v;
      else if (client && original !== null) body[key] = null;
    };
    const num = (key: string, value: string, original: number | null): void => {
      const v = value.trim();
      if (v !== '') body[key] = Number(v.replace(',', '.'));
      else if (client && original !== null) body[key] = null;
    };
    const date = (key: string, value: string, original: string | null): void => {
      if (value !== '') body[key] = new Date(`${value}T12:00:00Z`).toISOString();
      else if (client && original !== null) body[key] = null;
    };

    text('client_first_name', firstName, client?.client_first_name ?? null);
    text('client_last_name', lastName, client?.client_last_name ?? null);
    text('client_middle_name', middleName, client?.client_middle_name ?? null);
    text('email', email, client?.email ?? null);
    date('person_birthday', birthday, client?.person_birthday ?? null);
    if (product !== '') body.last_product_type = product;
    else if (client && client.last_product_type !== null) body.last_product_type = null;
    num('agreements_for_lastyear', agreementsLastYear, client?.agreements_for_lastyear ?? null);
    num('agreements_for_lifetime', agreementsLifetime, client?.agreements_for_lifetime ?? null);
    num('ban_days', banDays, client?.ban_days ?? null);
    body.notification_active = notificationActive;

    num('application_id', appId, client?.application_id ?? null);
    num('application_actual_status', appStatus, client?.application_actual_status ?? null);
    num('application_previous_status', appPrevStatus, client?.application_previous_status ?? null);

    num('agreement_id', agrId, client?.agreement_id ?? null);
    num('agreement_actual_status', agrStatus, client?.agreement_actual_status ?? null);
    num('agreement_previous_status', agrPrevStatus, client?.agreement_previous_status ?? null);
    num('loan_amount', loanAmount, client?.loan_amount ?? null);
    num('loan_period', loanPeriod, client?.loan_period ?? null);
    date('loan_closed_date', loanClosed, client?.loan_closed_date ?? null);

    date('person_offer_date_start', offerStart, client?.person_offer_date_start ?? null);
    date('person_offer_date_expired', offerExpired, client?.person_offer_date_expired ?? null);
    num('person_offer_approve_money', offerMoney, client?.person_offer_approve_money ?? null);
    num('person_offer_approve_days', offerDays, client?.person_offer_approve_days ?? null);
    if (offerAvailable !== '') body.person_offer_available = offerAvailable === 'yes';
    else if (client && client.person_offer_available !== null) body.person_offer_available = null;
    return body;
  }

  /** Черновики CF-полей → custom_fields для API: значения по типам; пустое поле,
   *  которое БЫЛО заполнено → null (очистка); новые поля без значения не отправляем. */
  function buildCustomFields(): Record<string, unknown> | undefined {
    if (cfFields.length === 0) return undefined;
    const out: Record<string, unknown> = {};
    for (const f of cfFields) {
      const raw = (cfDrafts[f.key] ?? '').trim();
      const had = fullClient?.customFields?.[f.key] !== undefined && fullClient.customFields[f.key] !== null;
      if (raw === '') {
        if (had) out[f.key] = null; // очистка значения
        continue;
      }
      switch (f.type) {
        case 'number': {
          const n = Number(raw.replace(',', '.'));
          if (Number.isFinite(n)) out[f.key] = n;
          else out[f.key] = null; // невалидное — не отправляем (сервер бы дал 422)
          break;
        }
        case 'date':
          out[f.key] = new Date(`${raw}T12:00:00Z`).toISOString();
          break;
        case 'bool':
          out[f.key] = raw === 'yes';
          break;
        default:
          out[f.key] = raw;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  // POST /clients (создание; externalId передаётся только здесь) / PUT /clients/{id} (правка).
  // data — доп. JSON-объект, объединяется с полями карточки из buildCardBody().
  const saveMutation = useMutation({
    mutationFn: async () => {
      let data: Record<string, unknown> = {};
      if (extraJson.trim().length > 0) {
        data = JSON.parse(extraJson) as Record<string, unknown>;
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('Доп. данные должны быть JSON-объектом');
        }
      }
      const body: Record<string, unknown> = {
        phone: phone.trim(),
        timezone: finalTz || undefined,
        data,
        smsConsentStatus: consent,
        ...buildCardBody(),
      };
      const customFields = buildCustomFields();
      if (customFields !== undefined) body.custom_fields = customFields;
      if (consentSource.trim().length > 0) body.smsConsentSource = consentSource.trim();
      if (client) {
        return api<ClientItem>(`/api/v1/clients/${client.id}`, { method: 'PUT', body });
      }
      return api<ClientItem>('/api/v1/clients', {
        method: 'POST',
        body: { ...body, externalId: externalId.trim() },
      });
    },
    onSuccess: () => {
      toast.success(client ? 'Клиент обновлён' : 'Клиент добавлен');
      invalidatePanel(queryClient);
      onOpenChange(false);
    },
    onError: (err) => {
      const detail =
        err instanceof ApiError ? err.detail ?? err.title : err instanceof Error ? err.message : 'Ошибка';
      setServerError(detail);
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // Сохранение доступно: externalId + телефон по формату + (пояс из списка или ручной)
  // + JSON без ошибок + числа валидны.
  const canSubmit =
    externalId.trim().length > 0 &&
    PHONE_RE.test(phone.trim()) &&
    (timezone !== OTHER_TZ || otherTz.trim().length > 0) &&
    jsonError === null &&
    !numberInvalid &&
    !saveMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{client ? `Клиент ${client.externalId}` : 'Новый клиент'}</DialogTitle>
          <DialogDescription>
            Карточка клиента + идентификатор external_id для событий
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* --- Идентификаторы: external_id (ключ событий от ядра) + телефон --- */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cl-external">External ID</Label>
              <Input
                id="cl-external"
                value={externalId}
                onChange={(e) => setExternalId(e.target.value)}
                placeholder="CL-0001"
                disabled={client !== null}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cl-phone">Телефон</Label>
              <Input
                id="cl-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+79001234567"
                inputMode="tel"
                aria-invalid={phoneInvalid}
              />
              {phoneInvalid ? (
                <p className="text-xs text-red-600 dark:text-red-400">Формат: +79001234567 (10–15 цифр)</p>
              ) : null}
            </div>
          </div>

          <CardSection icon={UserRound} title="Профиль" hint="ФИО, продукт, счётчики">
            <div className="space-y-1.5">
              <Label htmlFor="cl-last">Фамилия</Label>
              <Input id="cl-last" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Тестов" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cl-first">Имя</Label>
              <Input id="cl-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Иван" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cl-middle">Отчество</Label>
              <Input id="cl-middle" value={middleName} onChange={(e) => setMiddleName(e.target.value)} placeholder="Иванович" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cl-email">E-mail</Label>
              <Input id="cl-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ivan@example.com" />
            </div>
            <DateField id="cl-birthday" label="День рождения" value={birthday} onChange={setBirthday} />
            <div className="space-y-1.5">
              <Label>Продукт</Label>
              <Select value={product || 'none'} onValueChange={(v) => setProduct(v === 'none' ? '' : v)}>
                <SelectTrigger className="w-full" aria-label="Продукт">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— не указан —</SelectItem>
                  <SelectItem value="PDL">PDL (до зарплаты)</SelectItem>
                  <SelectItem value="IL">IL (рассрочка)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <NumberField id="cl-lastyear" label="Закрыто договоров за год" value={agreementsLastYear} onChange={setAgreementsLastYear} placeholder="2" />
            <NumberField id="cl-lifetime" label="Закрыто договоров всего" value={agreementsLifetime} onChange={setAgreementsLifetime} placeholder="5" />
            <NumberField id="cl-ban" label="Дни запрета заявки" value={banDays} onChange={setBanDays} placeholder="0 / 30 / 90" />
            <div className="space-y-1.5">
              <Label>Часовой пояс</Label>
              <Select value={timezone} onValueChange={setTimezone}>
                <SelectTrigger className="w-full" aria-label="Часовой пояс">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {timezoneOptionLabel(tz)}
                    </SelectItem>
                  ))}
                  <SelectItem value={OTHER_TZ}>Другая…</SelectItem>
                </SelectContent>
              </Select>
              {timezone === OTHER_TZ ? (
                <Input
                  className="mt-2"
                  value={otherTz}
                  onChange={(e) => setOtherTz(e.target.value)}
                  placeholder="Asia/Magadan или +5 / UTC+5"
                  aria-label="Свой часовой пояс"
                />
              ) : null}
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                IANA-имя или цифровое смещение UTC (как передаёт система данных: 5, «+5», «UTC+5»)
              </p>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3 sm:col-span-2">
              <div>
                <Label htmlFor="cl-notif" className="text-sm">
                  Разрешение на рекламные SMS
                </Label>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Выключено — реклама не отправляется (аналог person_exclude); сервисные SMS
                  доставляются
                </p>
              </div>
              <Switch id="cl-notif" checked={notificationActive} onCheckedChange={setNotificationActive} />
            </div>
          </CardSection>

          <CardSection icon={FileText} title="Заявка">
            <NumberField id="cl-appid" label="ID заявки" value={appId} onChange={setAppId} placeholder="551001" />
            <NumberField id="cl-appstatus" label="Статус заявки" value={appStatus} onChange={setAppStatus} placeholder="4 — одобрена, 9 — отказ" />
            <NumberField id="cl-appprev" label="Предыдущий статус" value={appPrevStatus} onChange={setAppPrevStatus} placeholder="1" />
          </CardSection>

          <CardSection icon={Briefcase} title="Договор">
            <NumberField id="cl-agrid" label="ID договора" value={agrId} onChange={setAgrId} placeholder="101001" />
            <NumberField
              id="cl-agrstatus"
              label="Статус договора"
              value={agrStatus}
              onChange={setAgrStatus}
              placeholder="16 / 17 / 19"
            />
            <NumberField id="cl-agrprev" label="Предыдущий статус" value={agrPrevStatus} onChange={setAgrPrevStatus} placeholder="15" />
            <NumberField id="cl-loanamount" label="Сумма займа, ₽" value={loanAmount} onChange={setLoanAmount} placeholder="15000" allowDecimal />
            <NumberField id="cl-loanperiod" label="Срок займа, дней" value={loanPeriod} onChange={setLoanPeriod} placeholder="21" />
            <DateField id="cl-loanclosed" label="Дата закрытия займа" value={loanClosed} onChange={setLoanClosed} />
          </CardSection>

          <CardSection icon={CalendarClock} title="Преапрув" hint="person_offer_*">
            <DateField id="cl-offerstart" label="Начало" value={offerStart} onChange={setOfferStart} />
            <DateField id="cl-offerexp" label="Окончание" value={offerExpired} onChange={setOfferExpired} />
            <NumberField id="cl-offermoney" label="Одобренная сумма, ₽" value={offerMoney} onChange={setOfferMoney} placeholder="25000" allowDecimal />
            <NumberField id="cl-offerdays" label="Одобренный срок, дней" value={offerDays} onChange={setOfferDays} placeholder="21" />
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="cl-offeravail">Доступен</Label>
              <Select value={offerAvailable || 'none'} onValueChange={(v) => setOfferAvailable(v === 'none' ? '' : v)}>
                <SelectTrigger className="w-full" aria-label="Преапрув доступен">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— не указано —</SelectItem>
                  <SelectItem value="yes">Да</SelectItem>
                  <SelectItem value="no">Нет</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardSection>

          {/* --- Кастомные поля профиля (динамический реестр ADMIN) --- */}
          {cfFields.length > 0 ? (
            <CardSection icon={Shapes} title="Кастомные поля" hint="переменные {{cf_*}}, сегментация">
              {cfFields.map((f) => {
                const cfId = `cl-cf-${f.key}`;
                const value = cfDrafts[f.key] ?? '';
                if (f.type === 'date') {
                  return (
                    <DateField key={f.key} id={cfId} label={f.label} value={value} onChange={(v) => setCfDrafts((prev) => ({ ...prev, [f.key]: v }))} />
                  );
                }
                if (f.type === 'number') {
                  return (
                    <NumberField key={f.key} id={cfId} label={f.label} value={value} onChange={(v) => setCfDrafts((prev) => ({ ...prev, [f.key]: v }))} allowDecimal />
                  );
                }
                if (f.type === 'bool') {
                  return (
                    <div key={f.key} className="space-y-1.5">
                      <Label htmlFor={cfId}>{f.label}</Label>
                      <Select value={value || 'none'} onValueChange={(v) => setCfDrafts((prev) => ({ ...prev, [f.key]: v === 'none' ? '' : v }))}>
                        <SelectTrigger id={cfId} className="w-full" aria-label={f.label}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">— не указано —</SelectItem>
                          <SelectItem value="yes">Да</SelectItem>
                          <SelectItem value="no">Нет</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  );
                }
                return (
                  <div key={f.key} className="space-y-1.5">
                    <Label htmlFor={cfId}>{f.label}</Label>
                    <Input
                      id={cfId}
                      value={value}
                      onChange={(e) => setCfDrafts((prev) => ({ ...prev, [f.key]: e.target.value }))}
                      placeholder={`{{cf_${f.key}}}`}
                      maxLength={200}
                    />
                    <p className="text-xs text-zinc-400">{`Переменная шаблона: {{cf_${f.key}}}`}</p>
                  </div>
                );
              })}
            </CardSection>
          ) : null}

          <Separator />

          {/* --- Доп. данные (JSON) + согласие на SMS и его источник --- */}
          <div className="space-y-1.5">
            <Label htmlFor="cl-json">Доп. данные (JSON)</Label>
            <Textarea
              id="cl-json"
              className="font-mono text-sm"
              rows={3}
              value={extraJson}
              onChange={(e) => {
                setExtraJson(e.target.value);
                if (e.target.value.trim().length === 0) {
                  setJsonError(null);
                  return;
                }
                try {
                  const parsed: unknown = JSON.parse(e.target.value);
                  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    setJsonError('Доп. данные должны быть JSON-объектом');
                  } else {
                    setJsonError(null);
                  }
                } catch {
                  setJsonError('Некорректный JSON');
                }
              }}
              placeholder='{"loan_number": "LN-0001"}'
            />
            {jsonError ? <p className="text-xs text-red-600 dark:text-red-400">{jsonError}</p> : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Согласие на SMS</Label>
              <Select value={consent} onValueChange={(v) => setConsent(v as ConsentStatus)}>
                <SelectTrigger className="w-full" aria-label="Согласие на SMS">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(CONSENT_META) as ConsentStatus[]).map((c) => (
                    <SelectItem key={c} value={c}>
                      {CONSENT_META[c].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cl-source">Источник согласия</Label>
              <Input
                id="cl-source"
                value={consentSource}
                onChange={(e) => setConsentSource(e.target.value)}
                placeholder="договор"
              />
            </div>
          </div>

          {/* --- Отказ сервера (валидация/конфликты) --- */}
          {serverError ? (
            <Alert variant="destructive">
              <AlertTitle>Ошибка сохранения</AlertTitle>
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saveMutation.isPending}>
            Отмена
          </Button>
          <Button
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={!canSubmit}
            onClick={() => saveMutation.mutate()}
          >
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============================ Диалог импорта CSV ============================ */

/** Диалог импорта клиентов из CSV: выбор файла → предпросмотр первых строк →
 *  POST /clients/import. Сервер различает легаси-формат (позиции) и формат
 *  с заголовком-маппингом полей карточки (разбор — services/clients).
 *  Dry-run нет: «предпросмотр» — только клиентский (первые 5 строк), файл
 *  применяется одним POST целиком; строки — upsert по external_id (новый без
 *  телефона → ошибка строки), ошибки построчные и не прерывают остальные. */
function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [csv, setCsv] = React.useState('');
  const [fileName, setFileName] = React.useState('');
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Сброс состояния при закрытии диалога.
  React.useEffect(() => {
    if (!open) {
      setCsv('');
      setFileName('');
      setResult(null);
      setError(null);
    }
  }, [open]);

  // Непустые строки CSV и превью первых 5 — показать до отправки на сервер.
  const lines = React.useMemo(() => csv.split(/\r?\n/).filter((l) => l.trim().length > 0), [csv]);
  const preview = lines.slice(0, 5);

  // POST /api/v1/clients/import: {csv} → {created, updated, errors[]} (ошибки — по строкам).
  const importMutation = useMutation({
    mutationFn: async () => api<ImportResult>('/api/v1/clients/import', { method: 'POST', body: { csv } }),
    onSuccess: (res) => {
      setResult(res);
      setError(null);
      toast.success(`Импорт: создано ${res.created}, обновлено ${res.updated}`);
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Ошибка импорта';
      setError(detail);
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // Чтение выбранного файла в текст (File.text()); сбой чтения — в setError.
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    try {
      const text = await file.text();
      setCsv(text);
    } catch {
      setError('Не удалось прочитать файл');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Импорт клиентов из CSV</DialogTitle>
          <DialogDescription>Разделитель — «;» или «,»</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* --- Подсказка формата CSV (wrap-anywhere: длинные неразрывные
           *  перечисления колонок переносятся по границе символа, иначе
           *  mono-токен распирает грид-колонку диалога и появляется
           *  горизонтальный скролл) --- */}
          <div className="wrap-anywhere space-y-2 rounded-md bg-muted p-3 font-mono text-xs text-zinc-600 dark:text-zinc-400">
            <p>Вариант 1 (легаси, позиции): external_id;phone;timezone;name;consent</p>
            <p>
              Вариант 2 (заголовок с именами колонок — маппинг карточки):
              external_id;phone;client_first_name;client_last_name;agreement_actual_status;loan_amount;last_product_type;…
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="csv-file">Файл (.csv / .txt)</Label>
            <Input id="csv-file" type="file" accept=".csv,.txt" onChange={onFile} />
            {fileName ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {fileName} · {lines.length} строк(и)
              </p>
            ) : null}
          </div>

          {/* --- Предпросмотр первых строк --- */}
          {csv.length > 0 && !result ? (
            <div className="space-y-1">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Первые 5 строк:</p>
              <pre className="max-h-40 overflow-auto rounded-md border border-border bg-card p-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                {preview.join('\n')}
              </pre>
            </div>
          ) : null}

          {/* --- Результат импорта: счётчики + ошибки по строкам --- */}
          {result ? (
            <Alert className="border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300">
              <AlertTitle>Импорт завершён</AlertTitle>
              <AlertDescription>
                <p>
                  Создано: {result.created}, Обновлено: {result.updated}
                </p>
                {result.errors.length > 0 ? (
                  <div className="mt-2">
                    <p className="font-medium">Ошибки ({result.errors.length}):</p>
                    <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto text-xs text-red-600 dark:text-red-400">
                      {result.errors.map((e, i) => (
                        <li key={i}>
                          Строка {e.line}: {e.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Ошибка импорта</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Закрыть
          </Button>
          {/* result !== null: после успешного импорта кнопка гасится до закрытия
              диалога — повторный клик применил бы тот же файл ещё раз (upsert);
              сброс результата делает только эффект закрытия выше. */}
          <Button
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={lines.length === 0 || importMutation.isPending || result !== null}
            onClick={() => importMutation.mutate()}
          >
            Импортировать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============================ Карточка клиента: профиль + история SMS ============================ */

/** Агрегаты истории отправок (GET /api/v1/clients/{id}/messages). */
interface ClientSmsStats {
  total: number;
  delivered: number;
  sent: number;
  failed: number;
  rejected: number;
  queued: number;
  lastAt: string | null;
}

/** Страница истории SMS клиента: items + total + агрегаты stats (считает сервер). */
interface ClientSmsPage {
  items: SmsMessage[];
  total: number;
  stats: ClientSmsStats;
  page: number;
  pageSize: number;
}

/** Строка «метка — значение» в сетке профиля. min-w-0 — обязательный компенсатор
 *  grid-элемента: без него длинные неразрывные значения распирают колонку сетки
 *  шире контейнера и карточка получает горизонтальный скролл. */
function InfoField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-xs text-zinc-400">{label}</p>
      <div className="break-words text-sm text-zinc-700 dark:text-zinc-300">{children}</div>
    </div>
  );
}

/** Сумма в ₽ с разделителями (null → «—»). */
function fmtMoney(v: number | null): string {
  if (v === null) return '—';
  return `${v.toLocaleString('ru-RU')} ₽`;
}

/** Цена из тарификации шлюза (копейки → ₽ с копейками). */
function fmtPrice(kopecks?: number | null): string {
  if (!kopecks || kopecks <= 0) return '—';
  return `${(kopecks / 100).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ₽`;
}

/** Карточка клиента (просмотр): бейджи статусов, профиль InfoField-сеткой и
 *  история отправок SMS (GET /clients/{id}/messages, обновление каждые 20с).
 *  Клик по строке истории открывает полный текст сообщения (второй Dialog ниже). */
function ClientCardDialog({
  open,
  onOpenChange,
  client,
  onEdit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: ClientItem | null;
  onEdit?: (client: ClientItem) => void;
}) {
  const [page, setPage] = React.useState(1);
  const [detail, setDetail] = React.useState<SmsMessage | null>(null);
  const [histPage, setHistPage] = React.useState(1);
  const pageSize = 10;

  // (Пере)открытие карточки — в т.ч. со сменой клиента — сбрасывает пагинацию
  // обеих историй и детальный просмотр SMS: без этого от предыдущего клиента
  // оставались бы чужая страница списка и открытое сообщение.
  React.useEffect(() => {
    if (open) {
      setPage(1);
      setDetail(null);
      setHistPage(1);
    }
  }, [open, client?.id]);

  // История SMS постранично (10 на страницу); refetchInterval 20с подтягивает
  // свежие статусы доставки без перезагрузки карточки.
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['client-sms', client?.id ?? '', page],
    queryFn: () =>
      api<ClientSmsPage>(`/api/v1/clients/${client?.id}/messages?page=${page}&pageSize=${pageSize}`),
    enabled: open && client !== null,
    refetchInterval: 20_000,
  });

  // История изменений профиля (P5): диффы по всем источникам; метки cf-полей —
  // из реестра активных кастомных полей (деактивированные покажутся ключом).
  const cfFields = useCustomFields();
  const cfLabelMap = React.useMemo(
    () => new Map((cfFields.data?.items ?? []).map((f) => [f.key, f.label] as const)),
    [cfFields.data],
  );
  const historyQ = useQuery({
    queryKey: ['client-history', client?.id ?? '', histPage],
    queryFn: () =>
      api<Paged<ProfileChangeItem>>(
        `/api/v1/clients/${client?.id}/history?page=${histPage}&pageSize=${pageSize}`,
      ),
    enabled: open && client !== null,
  });
  const historyItems = historyQ.data?.items ?? [];

  const items = data?.items ?? [];
  const stats = data?.stats;

  return (
    <>
      <Dialog
        open={open && client !== null}
        onOpenChange={(o) => {
          if (!o) onOpenChange(false);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl md:max-w-4xl lg:max-w-5xl xl:max-w-6xl">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <UserRound className="size-5 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <span className="break-words">{client ? clientFullName(client) : ''}</span>
            </DialogTitle>
            <DialogDescription>
              {client ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{client.phone}</span>
                  <span className="font-mono text-zinc-400">· {client.externalId}</span>
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          {client ? (
            <div className="space-y-4">
              {/* Статусы и флаги */}
              <div className="flex flex-wrap items-center gap-2">
                <ConsentBadge status={client.smsConsentStatus} />
                <AgreementStatusBadge status={client.agreement_actual_status} />
                <ProductBadge product={client.last_product_type} />
                {client.unsubscribedAt ? (
                  <Badge
                    variant="outline"
                    className="border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-400"
                    title={fmtDT(client.unsubscribedAt)}
                  >
                    отписан
                  </Badge>
                ) : null}
                {client.notification_active === false ? (
                  <Badge
                    variant="outline"
                    className="border-orange-200 dark:border-orange-900 bg-orange-50 dark:bg-orange-950/60 text-orange-700 dark:text-orange-400"
                    title="notification_active = false — реклама этому клиенту не отправляется"
                  >
                    реклама выключена
                  </Badge>
                ) : null}
              </div>

              {/* Профиль */}
              <section className="rounded-lg border border-border p-4">
                <div className="mb-3 flex items-center gap-2">
                  <FileText className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
                  <h3 className="text-sm font-medium text-foreground">Профиль</h3>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  <InfoField label="E-mail">{client.email ?? '—'}</InfoField>
                  <InfoField label="День рождения">
                    {client.person_birthday ? fmtDate(client.person_birthday) : '—'}
                  </InfoField>
                  <InfoField label="Часовой пояс">{client.timezone}</InfoField>
                  <InfoField label="В базе с">{fmtDT(client.createdAt)}</InfoField>
                  <InfoField label="Сумма займа">{fmtMoney(client.loan_amount)}</InfoField>
                  <InfoField label="Срок займа">
                    {client.loan_period !== null ? `${client.loan_period} дн.` : '—'}
                  </InfoField>
                  <InfoField label="Заявка">
                    {client.application_id !== null
                      ? `№${client.application_id}${client.application_actual_status !== null ? ` · статус ${client.application_actual_status}` : ''}`
                      : '—'}
                  </InfoField>
                  <InfoField label="Договор">
                    {client.agreement_id !== null ? `№${client.agreement_id}` : '—'}
                  </InfoField>
                  <InfoField label="Закрытых договоров">
                    {client.agreements_for_lastyear !== null || client.agreements_for_lifetime !== null
                      ? `${client.agreements_for_lastyear ?? 0} за год · ${client.agreements_for_lifetime ?? 0} всего`
                      : '—'}
                  </InfoField>
                  <InfoField label="Дата закрытия займа">
                    {client.loan_closed_date ? fmtDate(client.loan_closed_date) : '—'}
                  </InfoField>
                </div>
              </section>

              {/* История изменений профиля (P5) */}
              <section className="rounded-lg border border-border p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <History className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
                    История изменений профиля
                  </h3>
                  {historyQ.data ? (
                    <span className="text-xs text-zinc-400">всего: {historyQ.data.total}</span>
                  ) : null}
                </div>
                {historyQ.isPending ? (
                  <div className="space-y-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <Skeleton key={i} className="h-9" />
                    ))}
                  </div>
                ) : historyQ.error ? (
                  <ErrorState error={historyQ.error} onRetry={() => void historyQ.refetch()} />
                ) : historyItems.length === 0 ? (
                  <div className="py-2">
                    <EmptyState icon={History} title="Изменений ещё не было" />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="max-h-56 overflow-y-auto rounded-md border border-border">
                      {/* table-fixed + ширины колонок: без этого nowrap-колонки «Когда»/«Поле»
                          задают min-content таблицы ~450px и распирают карточку на мобильных. */}
                      <Table className="table-fixed">
                        <TableHeader className="sticky top-0 z-10 bg-muted">
                          <TableRow>
                            <TableHead className="w-[84px] sm:w-[118px]">Когда</TableHead>
                            <TableHead className="w-[30%] sm:w-[32%]">Поле</TableHead>
                            <TableHead>Изменение</TableHead>
                            <TableHead className="hidden w-[140px] md:table-cell">Источник</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {historyItems.map((h) => (
                            <TableRow key={h.id}>
                              <TableCell className="whitespace-normal py-2 align-top text-xs text-zinc-500 dark:text-zinc-400">
                                <span title={fmtDT(h.createdAt)}>{relTime(h.createdAt)}</span>
                              </TableCell>
                              <TableCell className="whitespace-normal break-words py-2 align-top text-sm">
                                {profileHistoryFieldLabel(h.field, cfLabelMap)}
                              </TableCell>
                              <TableCell className="whitespace-normal py-2 align-top text-xs text-zinc-600 dark:text-zinc-400">
                                {h.field === PROFILE_FIELD_CREATED ? (
                                  <span className="text-zinc-500">профиль заведён в базу</span>
                                ) : (
                                  <span className="break-words">
                                    <span className="text-zinc-400 line-through">
                                      {formatProfileHistoryValue(h.oldValue)}
                                    </span>
                                    {' → '}
                                    <span className="font-medium text-zinc-700 dark:text-zinc-300">
                                      {formatProfileHistoryValue(h.newValue)}
                                    </span>
                                  </span>
                                )}
                                {h.details && typeof h.details.actorEmail === 'string' ? (
                                  <p className="mt-0.5 text-[10px] text-zinc-400">{h.details.actorEmail}</p>
                                ) : null}
                                {h.details && typeof h.details.jobName === 'string' ? (
                                  <p className="mt-0.5 text-[10px] text-zinc-400">операция: {h.details.jobName}</p>
                                ) : null}
                              </TableCell>
                              <TableCell className="hidden py-2 align-top md:table-cell">
                                <Badge variant="outline" className={PROFILE_SOURCE_META[h.source]?.badge ?? ''}>
                                  {PROFILE_SOURCE_META[h.source]?.label ?? h.source}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    {/* Пагинация истории изменений — урезанная (не полный
                        TablePagination, как у SMS-истории ниже): одна кнопка
                        «Показать ещё» двигает histPage, который сидит в queryKey,
                        — сервер отдаёт следующую десятку записей. */}
                    {histPage * pageSize < (historyQ.data?.total ?? 0) ? (
                      <Button variant="outline" size="sm" onClick={() => setHistPage((p) => p + 1)}>
                        Показать ещё
                      </Button>
                    ) : null}
                  </div>
                )}
              </section>

              {/* История SMS */}
              <section className="rounded-lg border border-border p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <MessageSquare className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
                    История отправок SMS
                  </h3>
                  {/* Агрегаты истории: всего/доставлено/ошибки/отклонено + время последней */}
                  {stats ? (
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <Badge variant="secondary">всего: {stats.total}</Badge>
                      <Badge
                        variant="outline"
                        className="border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400"
                      >
                        доставлено: {stats.delivered}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400"
                      >
                        ошибки: {stats.failed}
                      </Badge>
                      {stats.rejected > 0 ? (
                        <Badge
                          variant="outline"
                          className="border-orange-200 dark:border-orange-900 bg-orange-50 dark:bg-orange-950/60 text-orange-700 dark:text-orange-400"
                        >
                          отклонено: {stats.rejected}
                        </Badge>
                      ) : null}
                      {stats.lastAt ? (
                        <span className="text-zinc-400" title={fmtDT(stats.lastAt)}>
                          последняя: {relTime(stats.lastAt)}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {isPending ? (
                  <div className="space-y-2">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Skeleton key={i} className="h-9" />
                    ))}
                  </div>
                ) : error ? (
                  <ErrorState error={error} onRetry={() => void refetch()} />
                ) : items.length === 0 ? (
                  <div className="py-2">
                    <EmptyState icon={Send} title="Этому клиенту SMS ещё не отправлялись" />
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="max-h-72 overflow-y-auto rounded-md border border-border">
                      {/* table-fixed: без него line-clamp-2 (display:-webkit-box) не участвует
                          в min-content-расчёте таблицы, и длинные тексты SMS распирают
                          автоколонку «Текст» шире карточки → горизонтальный скролл. */}
                      <Table className="table-fixed">
                        <TableHeader className="sticky top-0 z-10 bg-muted">
                          <TableRow>
                            <TableHead className="w-[124px]">Время</TableHead>
                            <TableHead>Текст</TableHead>
                            <TableHead className="hidden w-[24%] md:table-cell">Источник</TableHead>
                            <TableHead className="w-[104px]">Статус</TableHead>
                            <TableHead className="hidden w-[124px] md:table-cell">Доставлено</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {items.map((m) => (
                            <TableRow
                              key={m.id}
                              className="cursor-pointer hover:bg-muted"
                              onClick={() => setDetail(m)}
                            >
                              <TableCell className="py-2.5 align-top text-xs text-zinc-500 dark:text-zinc-400">
                                <span title={fmtDT(m.createdAt)}>{fmtDT(m.sentAt ?? m.createdAt)}</span>
                              </TableCell>
                              <TableCell className="py-2.5 align-top">
                                <p className="line-clamp-2 break-words text-sm text-zinc-600 dark:text-zinc-400" title={m.body}>
                                  {m.body}
                                </p>
                              </TableCell>
                              <TableCell className="hidden py-2.5 align-top text-xs text-zinc-500 dark:text-zinc-400 md:table-cell">
                                <p className="line-clamp-2 break-words" title={m.broadcastName ?? m.templateName ?? ''}>
                                  {m.broadcastName ?? m.templateName ?? '—'}
                                </p>
                              </TableCell>
                              <TableCell className="py-2.5 align-top">
                                <SmsBadge
                                  status={m.status}
                                  className="max-w-full whitespace-normal break-words"
                                />
                              </TableCell>
                              <TableCell className="hidden py-2.5 align-top text-xs text-zinc-500 dark:text-zinc-400 md:table-cell">
                                {m.deliveredAt ? fmtDT(m.deliveredAt) : '—'}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    <TablePagination page={page} pageSize={pageSize} total={data?.total ?? 0} onPage={setPage} />
                  </div>
                )}
              </section>
            </div>
          ) : null}

          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Закрыть
            </Button>
            {client && onEdit ? (
              <ViewerGuard>
                <Button
                  onClick={() => onEdit(client)}
                  aria-label={`Редактировать клиента ${client.externalId}`}
                >
                  <Pencil className="size-4" aria-hidden />
                  Редактировать
                </Button>
              </ViewerGuard>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Полный текст конкретного сообщения (клик по строке истории) */}
      <Dialog
        open={detail !== null}
        onOpenChange={(o) => {
          if (!o) setDetail(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl md:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-base">{detail?.phone}</DialogTitle>
            <DialogDescription>
              {detail ? (
                <span className="flex flex-wrap items-center gap-2">
                  <SmsBadge status={detail.status} />
                  <span>{detail.segments} сегм</span>
                  <span>
                    · провайдер: {detail.provider === 'sandbox' ? 'песочница' : PROVIDER_LABELS[detail.provider] ?? detail.provider}
                  </span>
                  {detail.operatorCode ? <span>· оператор: {detail.operatorCode}</span> : null}
                  {detail.priceKopecks ? <span>· стоимость: {fmtPrice(detail.priceKopecks)}</span> : null}
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          {detail ? (
            <div className="space-y-3">
              <div className="rounded-2xl border border-border bg-muted p-4">
                {/* wrap-anywhere (а не break-words): учитывается в min-content грида —
                    длинные URL-трекеры в тексте SMS не распирают диалог */}
                <p className="whitespace-pre-wrap wrap-anywhere font-mono text-sm text-zinc-800 dark:text-zinc-200">
                  {detail.body}
                </p>
              </div>
              {/* Снимок переменных (P6): что подставилось в момент рендера */}
              <SmsVarsSnapshot vars={detail.varsSnapshot} />
              <div className="space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                {detail.templateName ? <p>Шаблон: {detail.templateName}</p> : null}
                {detail.broadcastName ? <p>Рассылка: {detail.broadcastName}</p> : null}
                {detail.providerMessageId ? (
                  <p className="font-mono">ID провайдера: {detail.providerMessageId}</p>
                ) : null}
                {detail.rejectReason ? (
                  <p className="text-orange-600 dark:text-orange-400">Причина: {REJECT_REASON_TEXT[detail.rejectReason]}</p>
                ) : null}
                {detail.error ? <p className="text-red-600 dark:text-red-400">Ошибка: {detail.error}</p> : null}
                <p>Создано: {fmtDT(detail.createdAt)}</p>
                <p>Отправлено: {fmtDT(detail.sentAt)}</p>
                <p>Доставлено: {fmtDT(detail.deliveredAt)}</p>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ============================ Массовое обновление (P4) ============================ */

/** Мини-тип сегмента для селектора операции (полный SegmentItem живёт в segments-view). */
interface MassUpdateSegment {
  id: string;
  name: string;
  mode: 'dynamic' | 'static';
}

/** Описание поля, доступного массовому обновлению: кастомные поля профиля
 *  (активные) + системные поля панели (реклама/согласие). Поля системы данных НЕ
 *  поддерживаются — их перезапишет ближайшее событие client_card. */
interface MassUpdateFieldDef {
  field: string; // cf_<key> | notification_active | sms_consent_status
  label: string;
  kind: 'cf' | 'system';
  type: 'text' | 'number' | 'date' | 'bool' | 'consent';
  hint?: string;
}

/** Значение правила при отправке: null = «очистить» (только кастомные поля). */
type MassUpdateValueDraft = { value: string; clear: boolean };

/** Форматирование значения правила журнала: null → «очистить», bool → да/нет,
 *  ISO-дату → дд.мм.гггг (значения уже строковые от API). */
function formatMassUpdateValue(v: string | number | boolean | null): string {
  if (v === null) return 'очистить';
  if (v === true) return 'да';
  if (v === false) return 'нет';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
    try {
      return fmtDate(s);
    } catch {
      return s;
    }
  }
  return s;
}

/** Диалог массового обновления: вкладка «Операция» (сегмент + поля + кап) и
 *  вкладка «Журнал операций» (прогресс воркера, отмена). Создание — MANAGER+
 *  (кнопка открывается под ViewerGuard). */
function MassUpdateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = React.useState<'new' | 'log'>('new');
  const [name, setName] = React.useState('');
  const [segmentId, setSegmentId] = React.useState('');
  const [maxAffected, setMaxAffected] = React.useState('10000');
  const [logPage, setLogPage] = React.useState(1);
  /** Выбранные поля: field → значение-черновик (строка) + флаг «очистить». */
  const [drafts, setDrafts] = React.useState<Record<string, MassUpdateValueDraft>>({});

  React.useEffect(() => {
    if (open) {
      setTab('new');
      setLogPage(1);
    }
  }, [open]);

  // Сегменты и активные кастомные поля — источники селекторов операции
  const segmentsQ = useQuery({
    queryKey: ['segments'],
    queryFn: () => api<{ items: MassUpdateSegment[] }>('/api/v1/segments'),
    enabled: open,
  });
  const cfQ = useCustomFields();

  // Численность сегмента — превью масштаба операции (кэш 5 мин на сервере)
  const countQ = useQuery({
    queryKey: ['segment-count', segmentId],
    queryFn: () => api<{ total: number; mode: string; computedAt: string | null }>(`/api/v1/segments/${segmentId}/count`),
    enabled: open && segmentId !== '',
  });

  // Журнал операций: живее при активных задачах (воркер каждые 5с двигает счётчики)
  const jobsQ = useQuery({
    queryKey: ['mass-update-jobs', logPage],
    queryFn: () =>
      api<Paged<MassUpdateJobItem>>(
        `/api/v1/clients/mass-update?page=${logPage}&pageSize=10`,
      ),
    enabled: open,
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      return items.some((j) => j.status === 'PENDING' || j.status === 'RUNNING') ? 5_000 : 30_000;
    },
  });

  /** Доступные поля: системные + активные кастомные (в порядке реестра). */
  const fieldDefs = React.useMemo<MassUpdateFieldDef[]>(() => {
    const cf: MassUpdateFieldDef[] = (cfQ.data?.items ?? []).map((f) => ({
      field: f.varName,
      label: f.label,
      kind: 'cf',
      type: f.type,
      hint: f.varName,
    }));
    const system: MassUpdateFieldDef[] = [
      { field: 'notification_active', label: 'Реклама разрешена', kind: 'system', type: 'bool', hint: 'notification_active — хранение без комплаенс-эффекта' },
      { field: 'sms_consent_status', label: 'Статус SMS-согласия', kind: 'system', type: 'consent', hint: 'NONE | PENDING | GRANTED | REVOKED' },
    ];
    return [...cf, ...system];
  }, [cfQ.data]);

  const labelByField = React.useMemo(
    () => new Map(fieldDefs.map((d) => [d.field, d.label] as const)),
    [fieldDefs],
  );

  /** Черновики → правила API (валидация типов; невалидное значение — строка
   *  ошибки, отправка блокируется). */
  const buildUpdates = (): { updates?: Array<{ field: string; value: string | number | boolean | null }>; error?: string } => {
    const updates: Array<{ field: string; value: string | number | boolean | null }> = [];
    for (const def of fieldDefs) {
      const draft = drafts[def.field];
      if (draft === undefined) continue;
      if (def.kind === 'cf' && draft.clear) {
        updates.push({ field: def.field, value: null });
        continue;
      }
      const raw = draft.value.trim();
      switch (def.type) {
        case 'text':
          if (raw === '') return { error: `«${def.label}»: значение не заполнено` };
          updates.push({ field: def.field, value: raw });
          break;
        case 'number': {
          const n = Number(raw.replace(',', '.'));
          if (raw === '' || !Number.isFinite(n)) return { error: `«${def.label}»: ожидается число` };
          updates.push({ field: def.field, value: n });
          break;
        }
        case 'date': {
          if (raw === '' || Number.isNaN(Date.parse(raw))) return { error: `«${def.label}»: ожидается дата` };
          updates.push({ field: def.field, value: raw });
          break;
        }
        case 'bool':
          if (raw !== 'true' && raw !== 'false') return { error: `«${def.label}»: выберите да/нет` };
          updates.push({ field: def.field, value: raw === 'true' });
          break;
        case 'consent':
          if (!['NONE', 'PENDING', 'GRANTED', 'REVOKED'].includes(raw)) {
            return { error: `«${def.label}»: выберите статус` };
          }
          updates.push({ field: def.field, value: raw });
          break;
      }
    }
    return { updates };
  };

  const selectedCount = Object.keys(drafts).length;
  const maxAffectedNum = Number(maxAffected);
  const canSubmit =
    name.trim().length > 0 &&
    segmentId !== '' &&
    selectedCount > 0 &&
    Number.isInteger(maxAffectedNum) &&
    maxAffectedNum >= 1 &&
    maxAffectedNum <= 100_000;

  const createMutation = useMutation({
    mutationFn: async (payload: { name: string; segmentId: string; updates: Array<{ field: string; value: string | number | boolean | null }>; maxAffected: number }) =>
      api<MassUpdateJobItem>('/api/v1/clients/mass-update', { method: 'POST', body: payload }),
    onSuccess: (job) => {
      toast.success(`Операция «${job.name}» создана — воркер выполнит её в ближайшие секунды`);
      setName('');
      setDrafts({});
      setLogPage(1);
      setTab('log');
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? err.detail ?? err.title : 'Не удалось создать операцию';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (id: string) => api<MassUpdateJobItem>(`/api/v1/clients/mass-update/${id}/cancel`, { method: 'POST' }),
    onSuccess: (job) => {
      toast.success(`Операция «${job.name}» отменена`);
      void queryClient.invalidateQueries({ queryKey: ['mass-update-jobs'] });
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? err.detail ?? err.title : 'Не удалось отменить операцию';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  function submit() {
    const { updates, error } = buildUpdates();
    if (error !== undefined) {
      toast.error(error);
      return;
    }
    if (updates === undefined || updates.length === 0) {
      toast.error('Выберите хотя бы одно поле для обновления');
      return;
    }
    createMutation.mutate({ name: name.trim(), segmentId, updates, maxAffected: maxAffectedNum });
  }

  /** Контрол значения одного выбранного поля. */
  function valueControl(def: MassUpdateFieldDef): React.ReactNode {
    const draft = drafts[def.field] ?? { value: '', clear: false };
    const setDraft = (next: Partial<MassUpdateValueDraft>) =>
      setDrafts((prev) => ({ ...prev, [def.field]: { ...draft, ...next } }));
    if (def.kind === 'cf' && draft.clear) return null;
    switch (def.type) {
      case 'bool':
        return (
          <Select value={draft.value || 'true'} onValueChange={(v) => setDraft({ value: v })}>
            <SelectTrigger className="h-8 w-[110px]" aria-label={`Значение «${def.label}»`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">да</SelectItem>
              <SelectItem value="false">нет</SelectItem>
            </SelectContent>
          </Select>
        );
      case 'consent':
        return (
          <Select value={draft.value || 'GRANTED'} onValueChange={(v) => setDraft({ value: v })}>
            <SelectTrigger className="h-8 w-[170px]" aria-label={`Значение «${def.label}»`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CONSENT_META) as ConsentStatus[]).map((c) => (
                <SelectItem key={c} value={c}>
                  {CONSENT_META[c].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      case 'date':
        return (
          <Input
            type="date"
            className="h-8 w-[170px]"
            value={draft.value}
            onChange={(e) => setDraft({ value: e.target.value })}
            aria-label={`Значение «${def.label}»`}
          />
        );
      case 'number':
        return (
          <Input
            type="text"
            inputMode="decimal"
            className="h-8 w-[170px]"
            placeholder="число"
            value={draft.value}
            onChange={(e) => setDraft({ value: e.target.value })}
            aria-label={`Значение «${def.label}»`}
          />
        );
      default:
        return (
          <Input
            type="text"
            className="h-8 w-[200px]"
            placeholder="значение"
            value={draft.value}
            onChange={(e) => setDraft({ value: e.target.value })}
            aria-label={`Значение «${def.label}»`}
          />
        );
    }
  }

  const jobs = jobsQ.data?.items ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="size-5 text-emerald-600 dark:text-emerald-400" aria-hidden />
            Массовое обновление клиентов
          </DialogTitle>
          <DialogDescription>
            Проставить поля сегменту: кастомные поля профилей, «реклама разрешена», статус SMS-согласия.
            Поля карточки клиента не поддерживаются — их перезапишет ближайшее событие ядра.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'new' | 'log')}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="new">Новая операция</TabsTrigger>
            <TabsTrigger value="log">Журнал операций</TabsTrigger>
          </TabsList>

          {/* --- Вкладка: новая операция --- */}
          <TabsContent value="new" className="space-y-4 pt-2">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mass-name">Название операции</Label>
                <Input
                  id="mass-name"
                  placeholder="Например: Признак кредитной линии — сегменту лояльных"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Сегмент</Label>
                <Select value={segmentId} onValueChange={setSegmentId}>
                  <SelectTrigger aria-label="Сегмент операции">
                    <SelectValue placeholder={segmentsQ.isPending ? 'Загрузка…' : 'Выберите сегмент'} />
                  </SelectTrigger>
                  <SelectContent>
                    {(segmentsQ.data?.items ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                        {s.mode === 'static' ? ' (фиксированный)' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {countQ.data ? (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Клиентов в сегменте: {countQ.data.total.toLocaleString('ru-RU')}
                    {countQ.data.mode === 'dynamic' && countQ.data.computedAt ? (
                      <span title={countQ.data.computedAt}> · посчитано {relTime(countQ.data.computedAt)}</span>
                    ) : null}
                  </p>
                ) : null}
              </div>
            </div>

            {/* Поля обновления */}
            <div className="space-y-2">
              <Label>Поля для обновления</Label>
              {cfQ.isPending ? (
                <Skeleton className="h-8" />
              ) : null}
              <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-md border border-border p-2">
                {fieldDefs.map((def) => {
                  const selected = drafts[def.field] !== undefined;
                  const draft = drafts[def.field] ?? { value: '', clear: false };
                  return (
                    <div key={def.field} className="flex flex-wrap items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/60">
                      <Checkbox
                        id={`mu-${def.field}`}
                        checked={selected}
                        onCheckedChange={(c) => {
                          setDrafts((prev) => {
                            const next = { ...prev };
                            if (c) {
                              // Дефолт значений по типу: bool/consent — селекты, прочее — пусто
                              next[def.field] =
                                def.type === 'bool'
                                  ? { value: 'true', clear: false }
                                  : def.type === 'consent'
                                    ? { value: 'GRANTED', clear: false }
                                    : { value: '', clear: false };
                            } else {
                              delete next[def.field];
                            }
                            return next;
                          });
                        }}
                        aria-label={`Обновлять поле «${def.label}»`}
                      />
                      <label htmlFor={`mu-${def.field}`} className="cursor-pointer select-none text-sm text-foreground" title={def.hint}>
                        {def.label}
                        <span className="ml-1 font-mono text-[10px] text-zinc-400">{def.field}</span>
                      </label>
                      <span className="ml-auto flex items-center gap-2">
                        {def.kind === 'cf' ? (
                          <label className="flex cursor-pointer items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                            <Checkbox
                              checked={draft.clear}
                              onCheckedChange={(c) =>
                                setDrafts((prev) => ({
                                  ...prev,
                                  [def.field]: { value: '', clear: c === true },
                                }))}
                              aria-label={`Очистить поле «${def.label}»`}
                            />
                            очистить
                          </label>
                        ) : null}
                        {selected ? valueControl(def) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mass-limit">Лимит изменений (предохранитель)</Label>
                <Input
                  id="mass-limit"
                  inputMode="numeric"
                  value={maxAffected}
                  onChange={(e) => setMaxAffected(e.target.value)}
                />
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Воркер применит не более N изменений и остановится
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {selectedCount > 0
                  ? `Полей: ${selectedCount} · масштаб: до ${(countQ.data?.total ?? 0).toLocaleString('ru-RU')} клиентов`
                  : 'Отметьте поля для обновления'}
              </p>
              <Button
                className="bg-emerald-600 text-white hover:bg-emerald-700"
                disabled={!canSubmit || createMutation.isPending}
                onClick={submit}
              >
                <Layers className="size-4" aria-hidden />
                {createMutation.isPending ? 'Создание…' : 'Запустить операцию'}
              </Button>
            </div>
          </TabsContent>

          {/* --- Вкладка: журнал операций --- */}
          <TabsContent value="log" className="space-y-3 pt-2">
            {jobsQ.isPending ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-12" />
                ))}
              </div>
            ) : jobsQ.error ? (
              <ErrorState error={jobsQ.error} onRetry={() => void jobsQ.refetch()} />
            ) : jobs.length === 0 ? (
              <EmptyState icon={Layers} title="Операций пока не было" />
            ) : (
              <div className="space-y-2">
                {jobs.map((job) => {
                  const progress = job.planned > 0 ? Math.min(100, Math.round((job.processed / job.planned) * 100)) : 0;
                  const active = job.status === 'PENDING' || job.status === 'RUNNING';
                  return (
                    <div key={job.id} className="space-y-1.5 rounded-lg border border-border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground" title={job.name}>
                            {job.name}
                          </p>
                          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                            {job.segmentName} · {relTime(job.createdAt)}
                            {job.createdByEmail ? ` · ${job.createdByEmail}` : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <MassUpdateStatusBadge status={job.status as MassUpdateStatus} />
                          {active ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={cancelMutation.isPending}
                              onClick={() => cancelMutation.mutate(job.id)}
                              aria-label={`Отменить операцию «${job.name}»`}
                            >
                              Отменить
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {job.updates.map((u, i) => (
                          <Badge key={`${job.id}-${u.field}-${i}`} variant="secondary" className="text-[10px]">
                            {(labelByField.get(u.field) ?? u.field)}: {formatMassUpdateValue(u.value)}
                          </Badge>
                        ))}
                      </div>
                      {active ? (
                        <div className="space-y-1">
                          <Progress value={progress} className="h-1.5" />
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">
                            обработано {job.processed.toLocaleString('ru-RU')} из {job.planned.toLocaleString('ru-RU')} · изменено{' '}
                            {job.affected.toLocaleString('ru-RU')}
                          </p>
                        </div>
                      ) : (
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          изменено {job.affected.toLocaleString('ru-RU')} из {job.planned.toLocaleString('ru-RU')}
                          {job.finishedAt ? ` · ${relTime(job.finishedAt)}` : ''}
                        </p>
                      )}
                      {job.error ? (
                        <p className="text-xs text-red-600 dark:text-red-400">Ошибка: {job.error}</p>
                      ) : null}
                    </div>
                  );
                })}
                {jobsQ.data ? (
                  <TablePagination
                    page={logPage}
                    pageSize={10}
                    total={jobsQ.data.total}
                    onPage={setLogPage}
                  />
                ) : null}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}


/* ============================ Список ============================ */

/** Корневой экран «Клиенты»: поиск (дебаунс) + фильтры (согласие/отписка) + таблица
 *  с пагинацией; диалоги — клиент, импорт CSV, карточка, подтверждение удаления. */
export function ClientsView() {
  const queryClient = useQueryClient();

  // Строка поиска: инпут мгновенный, в запрос уходит значение спустя 400 мс
  const [searchInput, setSearchInput] = React.useState('');
  const search = useDebounced(searchInput, 400);
  const [consent, setConsent] = React.useState('all');
  const [unsubscribed, setUnsubscribed] = React.useState('all');
  const [page, setPage] = React.useState(1);
  const pageSize = 20;

  // Смена поиска/фильтров — возврат на 1-ю страницу (иначе можно уйти за пределы выборки).
  React.useEffect(() => {
    setPage(1);
  }, [search, consent, unsubscribed]);

  // query-string для GET /clients: в URL попадают только заданные фильтры + пагинация
  const params = React.useMemo(() => {
    const p = new URLSearchParams();
    if (search.trim().length > 0) p.set('search', search.trim());
    if (consent !== 'all') p.set('consent', consent);
    if (unsubscribed !== 'all') p.set('unsubscribed', unsubscribed);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    return p.toString();
  }, [search, consent, unsubscribed, page]);

  // GET /api/v1/clients: постраничный список под текущие фильтры (ключ кэша — params).
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['clients', params],
    queryFn: () => api<Paged<ClientItem>>(`/api/v1/clients?${params}`),
  });

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<ClientItem | null>(null);
  const [importOpen, setImportOpen] = React.useState(false);
  const [massUpdateOpen, setMassUpdateOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<ClientItem | null>(null);
  const [cardTarget, setCardTarget] = React.useState<ClientItem | null>(null);

  // DELETE /clients/{id}; сервер отклонит удаление, если у клиента есть SMS/экземпляры воронок.
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api<void>(`/api/v1/clients/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Клиент удалён');
      setDeleteTarget(null);
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? err.detail ?? err.title : 'Не удалось удалить клиента';
      toast.error(`Ошибка: ${detail}`);
      setDeleteTarget(null);
    },
  });

  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      {/* --- Секция: поиск + действия (импорт CSV / добавить) --- */}
      <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between">
        <div className="relative w-full lg:max-w-md">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
          <Input
            className="pl-8"
            placeholder="Поиск: ID, телефон, ФИО, e-mail…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Поиск клиентов"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ViewerGuard>
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="size-4" aria-hidden />
              Импорт CSV
            </Button>
          </ViewerGuard>
          <ViewerGuard>
            <Button variant="outline" onClick={() => setMassUpdateOpen(true)}>
              <Layers className="size-4" aria-hidden />
              Массовое обновление
            </Button>
          </ViewerGuard>
          <ViewerGuard>
            <Button
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={() => {
                setEditTarget(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="size-4" aria-hidden />
              Добавить клиента
            </Button>
          </ViewerGuard>
        </div>
      </div>

      {/* --- Секция: фильтры (согласие на SMS, отписка) --- */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={consent} onValueChange={setConsent}>
          <SelectTrigger size="sm" className="w-[180px]" aria-label="Фильтр согласия">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Согласие: все</SelectItem>
            {(Object.keys(CONSENT_META) as ConsentStatus[]).map((c) => (
              <SelectItem key={c} value={c}>
                Согласие: {CONSENT_META[c].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={unsubscribed} onValueChange={setUnsubscribed}>
          <SelectTrigger size="sm" className="w-[160px]" aria-label="Фильтр отписки">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Отписан: все</SelectItem>
            <SelectItem value="true">Отписан: да</SelectItem>
            <SelectItem value="false">Отписан: нет</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* --- Таблица клиентов: загрузка / ошибка / пусто / строки --- */}
      <Card className="shadow-sm">
        <CardContent className="p-0">
          {isPending ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : error ? (
            <div className="p-4">
              <ErrorState error={error} onRetry={() => void refetch()} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Search}
              title={search ? 'Ничего не найдено — измените запрос' : 'Клиентов пока нет — добавьте первого'}
            />
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-muted">
                  <TableRow>
                    <TableHead>Клиент</TableHead>
                    <TableHead>Телефон</TableHead>
                    <TableHead className="hidden md:table-cell">Договор</TableHead>
                    <TableHead className="hidden lg:table-cell">Продукт</TableHead>
                    <TableHead>Согласие</TableHead>
                    <TableHead className="hidden xl:table-cell">Отписан</TableHead>
                    <TableHead className="hidden xl:table-cell">Создан</TableHead>
                    <TableHead className="text-right">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((c) => (
                    <TableRow key={c.id} className="hover:bg-muted">
                      <TableCell className="py-3">
                        <button
                          type="button"
                          className="text-left"
                          onClick={() => setCardTarget(c)}
                          aria-label={`Открыть карточку клиента ${c.externalId}: профиль и история SMS`}
                        >
                          <p className="text-sm font-medium text-foreground hover:underline hover:decoration-zinc-400">
                            {clientFullName(c)}
                          </p>
                          <p className="font-mono text-xs text-zinc-400">{c.externalId}</p>
                        </button>
                      </TableCell>
                      <TableCell className="py-3 font-mono text-sm text-zinc-700 dark:text-zinc-300">{c.phone}</TableCell>
                      <TableCell className="hidden py-3 md:table-cell">
                        <AgreementStatusBadge status={c.agreement_actual_status} />
                      </TableCell>
                      <TableCell className="hidden py-3 lg:table-cell">
                        <ProductBadge product={c.last_product_type} />
                      </TableCell>
                      <TableCell className="py-3">
                        <ConsentBadge status={c.smsConsentStatus} />
                      </TableCell>
                      <TableCell className="hidden py-3 xl:table-cell">
                        {c.unsubscribedAt ? (
                          <Badge
                            variant="outline"
                            className="border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-400"
                            title={fmtDT(c.unsubscribedAt)}
                          >
                            отписан
                          </Badge>
                        ) : (
                          <span className="text-sm text-zinc-400">—</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden py-3 text-xs text-zinc-500 dark:text-zinc-400 xl:table-cell">
                        {fmtDT(c.createdAt)}
                      </TableCell>
                      <TableCell className="py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-11"
                            onClick={() => setCardTarget(c)}
                            aria-label={`Карточка клиента ${c.externalId}: история SMS`}
                          >
                            <Eye className="size-4" aria-hidden />
                          </Button>
                          <ViewerGuard>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-11"
                              onClick={() => {
                                setEditTarget(c);
                                setDialogOpen(true);
                              }}
                              aria-label={`Редактировать клиента ${c.externalId}`}
                            >
                              <Pencil className="size-4" aria-hidden />
                            </Button>
                          </ViewerGuard>
                          <ViewerGuard>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-11 text-red-500 dark:text-red-400 hover:text-red-600 dark:text-red-400"
                              onClick={() => setDeleteTarget(c)}
                              aria-label={`Удалить клиента ${c.externalId}`}
                            >
                              <Trash2 className="size-4" aria-hidden />
                            </Button>
                          </ViewerGuard>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {/* --- Пагинация --- */}
          {data ? (
            <div className="px-4 pb-4">
              <TablePagination
                page={page}
                pageSize={pageSize}
                total={data.total}
                onPage={setPage}
              />
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* --- Диалоги: клиент / импорт / массовое обновление / карточка / подтверждение удаления --- */}
      <ClientDialog open={dialogOpen} onOpenChange={setDialogOpen} client={editTarget} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <MassUpdateDialog open={massUpdateOpen} onOpenChange={setMassUpdateOpen} />
      <ClientCardDialog
        open={cardTarget !== null}
        onOpenChange={(o) => {
          if (!o) setCardTarget(null);
        }}
        client={cardTarget}
        onEdit={(c) => {
          setCardTarget(null);
          setEditTarget(c);
          setDialogOpen(true);
        }}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить клиента {deleteTarget?.externalId}?</AlertDialogTitle>
            <AlertDialogDescription>
              У клиента не должно быть сообщений и запущенных экземпляров воронок, иначе удаление
              будет отклонено.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              // анти-двойной клик: блокируем кнопку, пока идёт запрос
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
              }}
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
