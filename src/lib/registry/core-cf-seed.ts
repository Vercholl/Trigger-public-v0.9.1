// Реестр «полей доработок системы данных» (ч.1–4) для регистрации кастомными
// полями (G4) — ЧИСТЫЕ ДАННЫЕ (без серверных импортов).
//
// Источник: контракт интеграции (доработки ч.1–4 — расширения карточки).
// 3 поля Кредитной линии (ч.3) уже зарегистрированы ранее
// (is_credit_line, available_tranche_sum, grace_period_days) — здесь их нет.
// Ключи — snake_case; источник может присылать camelCase (isSravniClient) и
// смешанные написания (isSravni_client) — приём нормализует все варианты
// (см. services/custom-fields.ts, cfNormKey).
//
// Регистрация: scripts/register-core-fields.ts (на текущей БД) и
// db-bootstrap.ts (свежие standalone-развёртывания) — идемпотентно, по ключу.

import type { CustomFieldType } from '@/lib/registry/cf-ns';

export interface CoreCfSeed {
  key: string;
  label: string;
  type: CustomFieldType;
  description: string;
}

/** 13 полей доработок ч.1–4 (кроме 3 зарегистрированных полей КЛ ч.3). */
export const CORE_CF_SEED: readonly CoreCfSeed[] = [
  // Доработки ч.1
  {
    key: 'last_agreement_close_date',
    label: 'Дата закрытия последнего договора',
    type: 'date',
    description: 'Доработка ч.1: фактическая дата закрытия последнего договора',
  },
  {
    key: 'agreement_close_date_planned',
    label: 'Плановая дата закрытия',
    type: 'date',
    description: 'Доработка ч.1: плановая дата закрытия (IL — расчёт из графика, PDL — current_payment_date; актуализируется ЧДП-джобом)',
  },
  {
    key: 'last_auth_date',
    label: 'Дата последней авторизации',
    type: 'date',
    description: 'Доработка ч.1: последняя авторизация клиента (ОТП/биометрия)',
  },
  {
    key: 'is_self_employed_client',
    label: 'Самозанятый',
    type: 'bool',
    description: 'Доработка ч.1: признак самозанятого (Т-ИД/Контур)',
  },
  {
    key: 'score_ball',
    label: 'Скоринг',
    type: 'number',
    description: 'Доработка ч.1: балл скоринга клиента',
  },
  {
    key: 'last_application_date_create',
    label: 'Дата создания последней заявки',
    type: 'date',
    description: 'Доработка ч.1',
  },
  {
    key: 'last_application_date_send',
    label: 'Дата отправки последней заявки',
    type: 'date',
    description: 'Доработка ч.1',
  },
  // Доработки ч.2
  {
    key: 'total_paid_amount',
    label: 'Всего выплачено, ₽',
    type: 'number',
    description: 'Доработка ч.2: total_paid_amount (cashflow, стат. 63/тип 67/кат. 59-60)',
  },
  {
    key: 'avg_loan_amount',
    label: 'Средняя сумма займа, ₽',
    type: 'number',
    description: 'Доработка ч.2: по договорам статусов 16/17/19/20, округление до копеек',
  },
  {
    key: 'last_agreement_overdue_days',
    label: 'Дней просрочки последнего договора',
    type: 'number',
    description: 'Доработка ч.2: late_days_count (передаётся при смене статуса)',
  },
  {
    key: 'application_declined_count',
    label: 'Подряд отклонённых заявок',
    type: 'number',
    description: 'Доработка ч.2',
  },
  // Доработка ч.3 (Кредитная линия)
  {
    key: 'last_product_type_closed',
    label: 'Тип продукта последнего закрытого займа',
    type: 'text',
    description: 'Доработка ч.3: PDL/IL/КЛ-семантика закрытых договоров',
  },
  // Доработка ч.4 (Сравни)
  {
    key: 'is_sravni_client',
    label: 'Клиент Сравни',
    type: 'bool',
    description: 'Доработка ч.4: заявка создана через Сравни (lid_gen_id=874); источник передаёт как isSravni_client',
  },
];
