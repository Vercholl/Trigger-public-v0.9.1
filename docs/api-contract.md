# REST API Contract — trigger `/api/v1`

Единый источник правды для бэкенда и фронтенда.

## Общие правила

- Все ответы — JSON. Ошибки — RFC 7807 ProblemDetail: `{"type":"about:blank","title":"...","status":400,"detail":"..."}`.
- Списки: `{"items":[...],"total":123,"page":1,"pageSize":20}`; параметры `page` (1-based), `pageSize` (по умолчанию 20, max 100), `search`, `status`, фильтры по смыслу.
- Аутентификация панели (двухуровневая):
  - Основная схема — cookie `tg_sid` (HttpOnly; SameSite=Lax на прямом http, `SameSite=None; Secure; Partitioned` за HTTPS-шлюзом — HTTPS определяется по нескольким сигналам, включая Origin/Referer, т.к. шлюз затирает `x-forwarded-proto`).
  - Фолбэк для сред, где браузер блокирует сторонние cookie (кросс-сайт iframe предпросмотра, Safari ITP): тот же токен сессии в заголовке `Authorization: Bearer <64hex>` на всех авторизованных эндпоинтах. Приоритет чтения сервером: cookie → Authorization.
- Роли: `ADMIN` (всё), `MANAGER` (CRUD клиентов/шаблонов/воронок, тестовые события, отмена экземпляров), `VIEWER` (только чтение).
- Публичные (без авторизации): `POST /events` (по X-Api-Key), `GET|POST /u` (короткие ссылки отписки), `GET|POST /unsubscribe`, `POST /hooks/events` (токен приёмника), `POST /webhooks/smstech`, `GET /webhooks/t2`, `POST /webhooks/mts`, `POST /webhooks/smsru` (спящий адаптер). Вне префикса `/api/v1`: `GET /r` (редирект именных коротких ссылок — путь в корне сайта) и `GET /api/health`. Каждый публичный эндпоинт защищён своей схемой (ключ/токен/HMAC) и rate-limit.
- 401 `{"title":"Не авторизован"}` при отсутствии/истечении сессии — фронт показывает экран входа.

## Auth

- `POST /auth/login` `{email, password}` → 200 `{user:{id,email,name,role,mustChangePassword}, sessionToken:"<64hex>"}` + Set-Cookie `tg_sid`. `sessionToken` — аварийный Bearer-фолбэк: клиент хранит его ТОЛЬКО если cookie-сессия не подтверждается через `/auth/me`. 401 при неверных данных; 423 при блокировке (брутфорс: 5 неудач → lock 15 мин).
- `POST /auth/logout` → 204 (работает и по cookie, и по Authorization: Bearer). Любая роль.
- `GET /auth/me` → 200 `{user:{...}}` | 401.
- `POST /auth/change-password` `{oldPassword, newPassword}` → 204. Политика newPassword (v0.8.6): ≥ 10 символов (env `PASSWORD_MIN_LENGTH`), буквы+цифры, не email/имя владельца, не из списка популярных, не повтор текущего и 5 последних (история). Лимит подбора старого: 10 попыток / 10 мин (429); каждая неудача — SECURITY-аудит. Инвалидирует прочие сессии, прежний пароль — в историю.
- `POST /auth/change-password/skip` → 204 — отложить обязательную смену пароля (сбрасывает `mustChangePassword`; смена остаётся доступной в меню профиля). Действует только на себя, любая аутентифицированная роль; кросс-сайтовый POST (принудительный skip из чужой страницы) отсекается тем же CSRF-гейтом, что и смена. Аудит `passwordChangeSkipped`.
- `GET /auth/sessions` → 200 `{items:[{id, createdAt, lastActivityAt, expiresAt, ip, userAgent, current}], total, policy:{ttlHours, idleHours}}` — СВОИ активные сессии (любая роль). id = sha256-хеш токена (токен по нему не восстановить).
- `DELETE /auth/sessions/{id}` → 204 — завершить свою сессию (текущую нельзя — 409 «используйте Выход»; чужая/мусор — 404). Аудит SESSION_REVOKED.
- `DELETE /auth/sessions?scope=others` → 200 `{revoked}` — завершить все прочие свои сессии. Аудит SESSION_REVOKED (scope=others).
- Проверка деактивации аккаунта выполняется ПОСЛЕ сверки пароля: неверный пароль на деактивированном аккаунте неотличим от неизвестного email (единый 401), честный 403 «Аккаунт деактивирован» — только при верном пароле (анти-перечисление по таймингу).
- Idle-таймаут сессий: 168 ч без активности по умолчанию (env `SESSION_IDLE_HOURS`, 0 = выкл; абсолютный TTL — 30 дней).

## Security (ADMIN)

- `GET /security/status` → 200 `{checks:[{id,title,status:'ok'|'warn'|'fail',value?,recommendation?}], metrics:{activeUsers,activeSessions,activeApiKeys,auditEntries,auditEntries24h,failedLogins24h,securityEvents24h,lockedAccounts}, policy:{passwordMinLength,passwordHistoryDepth,bcryptCost,sessionTtlHours,sessionIdleHours,loginRateLimit,accountLockout,changePasswordRateLimit,publicEndpointsBodyLimit}, generatedAt}` — самодиагностика защиты для ИБ: секреты заданы, дефолтный пароль сменён, webhook-и подписаны, креды зашифрованы, индикаторы атак. Секреты не раскрываются.

## Clients (MANAGER для записи, VIEWER чтение)

- `GET /clients?search=&page=&pageSize=&consent=&unsubscribed=` — search по externalId, phone, ФИО (имя/фамилия/отчество), e-mail, data (name). items: `{id, externalId, client_id, phone, timezone, <карточка клиента — см. ниже>, data:{...}, smsConsentStatus, smsConsentSource, smsConsentAt, unsubscribedAt, createdAt}`.
- `POST /clients` `{externalId, phone, timezone?, data?, smsConsentStatus?, smsConsentSource?, custom_fields?, <поля карточки клиента>}` → 201 item. Валидация: phone E.164 (`^\+?[1-9]\d{7,14}$`, нормализация к `+`), externalId уникален (409). **timezone**: IANA-имя (`Asia/Yekaterinburg`) ИЛИ цифровое смещение UTC, как передаёт система данных — число `5` или строки `"5"`, `"+5"`, `"-3"`, `"+05:00"`, `"UTC+5"`, `"GMT-07:00"`; нормализуется в IANA-зону: целые +2..+12 → каноническая зона РФ (например 5 → `Asia/Yekaterinburg`, 2 → `Europe/Kaliningrad`), прочие целые → `Etc/GMT∓N`, дробные/мусор → 422 с подсказкой форматов. **custom_fields** — значения кастомных полей под ключами без префикса (`{"vip_level":"gold"}`, допускается и `cf_`-написание): неизвестный ключ или невалидное под тип значение → 422 со списком доступных; null/"" — очистка значения.
- `GET /clients/{id}` → item + `customFields:{ключ:значение}` (значения кастомных полей; даты — «дд.мм.гггг») | 404.
- `GET /clients/{id}/messages?page=&pageSize=` — история SMS-отправок клиента (карточка во «Клиентах»). Любая аутентифицированная роль (как и журнал SMS). → `{items:[<сообщение как в /sms>], total, page, pageSize, stats:{total, delivered, sent, failed, rejected, queued, lastAt|null}}`. Агрегаты считаются по ВСЕЙ истории клиента (не по странице); `queued` = QUEUED+SENDING+CANCELLED. 404, если клиента нет.
- `PUT /clients/{id}` — те же поля (вкл. `custom_fields`) → 200 item (с `customFields`). Поля карточки: значение — обновить, null — очистить, отсутствие — не трогать.
- `DELETE /clients/{id}` → 204 (запрещено 409, если есть сообщения/экземпляры).
- `POST /clients/import` `{csv:"..."}` → `{created, updated, errors:[{line, message}]}`. Разделитель `;` или `,`. Два формата: (1) легаси-позиционный `external_id;phone;timezone;name;consent` (строка с "external" без известных колонок — заголовок); (2) заголовок с именами колонок карточки (`external_id;phone;client_first_name;agreement_actual_status;loan_amount;last_product_type;...`) — маппинг по именам. Значения: числа ≥0, true/false/1/0/да/нет, даты ISO или дд.мм.гггг; consent ∈ {NONE,PENDING,GRANTED,REVOKED}. Колонка timezone — те же формы, что и в POST /clients (IANA-имя или цифровое смещение UTC: `5`, `+5`, `UTC+5`).

### Массовое обновление по сегменту (P4, запись — MANAGER+)

Аналог «mass update»: проставить поля, которыми управляет ПАНЕЛЬ, сразу сегменту — кастомные поля `cf_<key>`, `notification_active` («реклама разрешена») и `sms_consent_status`. Поля карточки клиента НЕ поддерживаются сознательно: ближайшее событие client_card перезапишет их. Операцию исполняет воркер (одна PENDING за тик, порции по 500 клиентов); каждое ФАКТИЧЕСКОЕ изменение фиксируется в истории профиля (source=MASS_UPDATE с именем операции).

- `GET /clients/mass-update?page=&pageSize=` (любая аутентифицированная роль) → `{items:[{id, name, segmentId, segmentName, updates:[{field, value}], maxAffected, status, planned, processed, affected, error, createdByEmail, startedAt, finishedAt, createdAt, updatedAt}], total, page, pageSize}`. `status`: PENDING → RUNNING → DONE | FAILED | CANCELLED; `planned` — численность сегмента на момент запуска; `processed`/`affected` — прогресс (обновляются воркером; affected — только реальные изменения после диффа «уже равно», повторный запуск идемпотентен).
- `POST /clients/mass-update` `{name, segmentId, updates:[{field, value}], maxAffected?}` (MANAGER+) → 201 item. `updates` 1–20 правил: `field` = `cf_<key>` (кастомное поле, включая деактивированное — значения можно перезаписать/очистить) | `notification_active` | `sms_consent_status`; `value` — строка/число/булев по типу поля, `null` — «очистить» (только cf). `maxAffected` — предохранитель (1…100000, по умолчанию 10000): применить не более N изменений. Ошибки: 404 — сегмент не найден; 422 — неизвестное поле/несоответствие типа (списком), дубль поля, пустые правила.
- `POST /clients/mass-update/{id}/cancel` (MANAGER+) → 200 item. PENDING → не начнётся; RUNNING → воркер остановится между порциями (обработанное остаётся применённым, откат массовой записи не делается). Терминальные статусы → 409.

### История изменений профиля (P5, чтение — любая роль)

Append-only журнал «кто/когда/почему изменил поле»: диффы «было → стало» по ВСЕМ источникам изменения профиля — ручная правка панели (MANUAL), CSV-импорт (IMPORT), события системы данных из client_card (EVENT), массовое обновление (MASS_UPDATE). Записываются ТОЛЬКО фактические изменения (no-op не пишется); факт создания профиля — спец-строка `__created__`. Ретеншн — 180 дней (чистка воркером).

- `GET /clients/{id}/history?page=&pageSize=` → `{items:[{id, clientId, field, oldValue, newValue, source, details, createdAt}], total, page, pageSize}` | 404. `field` — имя поля карточки | `cf_<key>` | спец-ключи `phone`/`timezone`/`sms_consent_status`/`notification_active`/`__created__`; значения — строковые представления (даты ISO, булевы true/false, NULL = «пусто»); `details` — контекст: `{actorEmail}` | `{line}` | `{eventId, event}` | `{jobId, jobName}`.

### Карточка клиента (П1, имена полей 1:1 из интеграции с системой данных)

Все поля — плоско на верхнем уровне item и в create/update DTO; nullable (кроме notification_active):

| API-имя | Тип | Смысл |
|---|---|---|
| `client_first_name` / `client_last_name` / `client_middle_name` | string | имя / фамилия / отчество |
| `email` | string | |
| `application_id` / `application_actual_status` / `application_previous_status` | int ≥0 | последняя заявка и её статусы |
| `agreement_id` / `agreement_actual_status` / `agreement_previous_status` | int ≥0 | последний договор; 16=действующий, 17=пролонгирован, 19=закрыт |
| `loan_amount` / `loan_period` | number ≥0 / int ≥0 | сумма займа / срок в днях |
| `loan_closed_date` | ISO-дата | дата закрытия последнего займа (доработка системы данных, окт. 2026; сегменты «закрыл N дней назад», переменная `{{loan_closed_date}}`) |
| `notification_active` | boolean (default true) | разрешение на МАРКЕТИНГОВЫЕ SMS (аналог person_exclude): false → реклама отклоняется ADVERT_OFF, сервисные доставляются |
| `person_offer_date_start` / `person_offer_date_expired` | ISO-дата | преапрув: начало / конец |
| `person_offer_approve_money` / `person_offer_approve_days` | number ≥0 / int ≥0 | преапрув: сумма / срок |
| `person_offer_available` | boolean | доступен ли преапрув |
| `person_birthday` | ISO-дата | день рождения |
| `last_product_type` | `PDL` \| `IL` | продукт |
| `agreements_for_lastyear` / `agreements_for_lifetime` | int ≥0 | закрытых договоров за год / за всё время (в DTO принимается также алиас `agreements_for_last_year`) |
| `ban_days` | int ≥0 | дни запрета повторной заявки |
| `date_update` | ISO-дата | дата формирования данных в ядре |
| `client_id` | string | алиас externalId (только в ответах) |

## Custom fields — кастомные поля профиля (реестр: чтение — все, запись — ADMIN)

Облегчённый аналог «настраиваемой базы профилей»: поля, которые компания заводит сама (без доработки системы данных). Пространство имён: ключ поля без префикса (`vip_level`); во всех внешних контекстах значение живёт под именем `cf_<key>` — переменная `{{cf_vip_level}}`, ключ client_card `cf_vip_level` (или сырой `vip_level`, или camelCase-написание контракта системы данных `vipLevel` — применяются, пока не заняты реестром карточки), правило сегмента `field:"cf_vip_level"`. Хранение — EAV-lite: типизированные колонки valueStr/valueNum/valueDate/valueBool с индексами (сегментация — SQL EXISTS-подзапросами, JS-фильтрация миллионов строк исключена).

Живой кейс — продукт «Кредитная линия»: поля `is_credit_line` (bool), `available_tranche_sum` (number), `grace_period_days` (number); система данных передаёт их в `client_card` в написании контракта (`isCreditLine` / `available_tranche_sum` / `grace_period_days`), приём понимает все три написания ключа:

```json
{"event":"APPLICATION_APPROVED","external_id":"CL-0007",
 "client_card":{"phone":"+79001234567","isCreditLine":true,"available_tranche_sum":15000,"grace_period_days":10}}
```

— значения применятся к профилю как `cf_is_credit_line` / `cf_available_tranche_sum` / `cf_grace_period_days` и станут доступны переменным `{{cf_is_credit_line}}` и правилам сегментов (демо-реестр полей кейса сеет `scripts/expand-demo-data.ts`).

- `GET /custom-fields` — активные поля (любая роль: нужны конструктору сегментов и подсказкам шаблонов); `GET /custom-fields?includeInactive=1` — весь реестр (ADMIN-раздел). → `{items:[{id, key, varName:"cf_<key>", label, type, description, isActive, values, createdAt, updatedAt}]}`; `values` — число клиентов с заполненным значением (groupBy).
- `POST /custom-fields` `{key, label, type, description?}` (ADMIN) → 201 item. key: латиница/цифры/подчёркивание, 2–40, с буквы, lowercase; не `cf_…` (префикс добавится автоматически), не совпадает с полем карточки (422). Занятый ключ (включая деактивированное поле) → 409. type: `text` (строка ≤200) | `number` | `date` | `bool` — задаёт колонку хранения и операторы сегментации, ПОСЛЕ СОЗДАНИЯ НЕ МЕНЯЕТСЯ. Создание поля «поглощает» наблюдение радара с этим ключом (все написания: `<key>`, `cf_<key>`, camelCase; свежие события начнут применяться).
- `PATCH /custom-fields/{id}` `{label?, description?, isActive?}` (ADMIN) → 200 item. Ключ/тип неизменяемы. `isActive=false` — деактивация (обратимый путь): поле исчезает из конструктора сегментов/подсказок шаблонов и перестаёт приниматься из client_card, значения НЕ удаляются (живые шаблоны продолжают подставлять `{{cf_*}}`; сегменты с правилами по полю продолжают вычисляться).
- `DELETE /custom-fields/{id}` (ADMIN) → 204 — безвозвратное удаление: поле + ВСЕ значения клиентов (транзакция) + поглощение наблюдений радара по ключу; audit DELETE/CUSTOM_FIELD с числом удалённых значений. 409 «Поле используется» — переменная `{{cf_<key>}}` встречается в шаблонах (включая деактивированные), воронках (condition-выражения узлов) или сегментах (правила `cf_<key>`, включая static) — detail перечисляет имена; рассылки покрываются проверкой шаблонов (ссылаются через templateId), исторические данные (отправленные SMS, payload событий, история профиля) удаление не блокируют. Если система данных продолжит слать `cf_<key>` в client_card — радар честно подсветит ключ как неизвестный заново.
- Значения: PUT/POST `/clients` `custom_fields` (см. Clients); автоматически из `client_card` событий (см. Events); переменные `{{cf_<key>}}` в шаблонах/воронках/рассылках (формат дат — «дд.мм.гггг», как у карточки); сегменты — правила `cf_<key>` с операторами по типу (текст: равно/≠/содержит; число: сравнения; дата: окна относительно «сейчас»; да/нет: =).

## Templates

- `GET /templates?search=&page=&pageSize=&includeDeleted=` — items `{id, name, body, isMarketing, description, senderName, maxSegments, version, isActive, createdAt, updatedAt}`. По умолчанию только активные (архив isActive=false скрыт); `includeDeleted=1` — вместе с архивом (бейдж «удалён» в UI).
- `POST /templates` `{name, body, isMarketing, description?, senderName?, maxSegments=0}` → 201. body ≤ 1000 символов, name 1..100, description ≤ 500, senderName латиница/цифры/дефис ≤ 20, maxSegments 0..10 (0 = без лимита).
- `PUT /templates/{id}` → 200 (version инкрементируется; частичное обновление).
- `DELETE /templates/{id}` → 204 (soft-delete isActive=false; 409 если используется активной воронкой или ACTIVE/PAUSED-рассылкой — иначе её запуски упирались бы в 422 «Шаблон не найден или отключён»).
- `POST /templates/preview` `{body, sampleData:{...}, isMarketing, maxSegments?}` → `{rendered, cancelled, chars, segments, encoding:"GSM-7"|"UCS-2", variables:[...], requiredVariables:[...], renderedWithDisclaimer, segmentsWithDisclaimer, maxSegments, overLimit}`. Ошибка рендера → 422 с detail «Не заполнена переменная: {{x}}»; синтаксическая ошибка → 422 «Ошибка синтаксиса шаблона». `cancelled=true` — сработал `{{#cancel}}`; `overLimit=true` — итог (с дисклеймером) превышает maxSegments → при отправке будет SMS_TOO_LONG.
- `POST /templates` / `PUT` с синтаксически неверным body → 422 «Ошибка синтаксиса шаблона» (незакрытый блок, неизвестный фильтр и т.п.).

### Синтаксис шаблонов

- `{{var}}` — подстановка; отсутствие без дефолта → ошибка рендера, SMS не отправляется.
- `{{var|default:значение}}` / `{{var|default:"текст с пробелами"}}` — значение по умолчанию.
- Фильтры (цепочкой через `|`): `money` («25 000 ₽»), `number` («25 000»), `date` (ISO → «дд.мм.гггг»), `upper`, `lower`, `ucfirst`, `urlencode`.
- `{{#if var op значение}}…{{#else}}…{{#end}}` — операторы `== != > >= < <= ~=` (содержит) `!~` (не содержит); отсутствующая переменная в условии = ложь (не ошибка).
- `{{#variant}}…{{#or}}…{{#end}}` — случайный вариант текста (выбор при каждом рендере).
- `{{#cancel}}` — тихая отмена отправки: sms_messages.status=CANCELLED, rejectReason=TEMPLATE_CANCEL, воронка/рассылка продолжаются.

### Причины отказа / статусы (дополнение П6)

- `SMS_TOO_LONG` — итоговое сообщение (включая дисклеймер) длиннее maxSegments шаблона: REJECTED_BY_COMPLIANCE, сообщение не отправляется вообще.
- `TEMPLATE_CANCEL` — отмена шаблоном (`{{#cancel}}`), статус CANCELLED.
- Имя отправителя: приоритет SMS-узел воронки (`senderName`) → шаблон (`senderName`) → настройка `defaultSenderName`; провайдеру передаётся `SmsRequest.sender` (SMS.Tech — `sender_name`, Т2 — `shortcode`).

## Funnels

- `GET /funnels?search=&triggerEvent=&page=&pageSize=` — items `{id, name, triggerEvent, isActive, version, definition:{...}, entryMode, description, nodeCount, createdAt, updatedAt}`.
- `POST /funnels` `{name, triggerEvent, definition, entryMode?, description?}` → 201. definition валидируется (start_node существует; next/onTrue/onFalse/onEvent/onTimeout ссылаются на существующие узлы или null; sms-узлы → существующие активные шаблоны; condition-выражения парсятся; циклы обязаны содержать delay- или waitEvent-узел). 422 + detail.
- `PUT /funnels/{id}` → 200 (version+1).
- `POST /funnels/{id}/activate` → 200 item (isActive=true).
- `POST /funnels/{id}/deactivate` → 200 item.
- `DELETE /funnels/{id}` → 204 (409 если есть экземпляры).

`entryMode` — повторный вход при новом событии для клиента с экземпляром этой воронки:
- `SKIP_ACTIVE` (по умолчанию) — пропустить, пока экземпляр RUNNING/WAITING;
- `SKIP` — «один раз навсегда»: любой экземпляр (включая завершённые) блокирует запуск (в result события — `SKIPPED_ALREADY_PASSED`);
- `REPLACE` — активный экземпляр отменяется (задачи CANCELLED), стартует новый;
- `PARALLEL` — всегда запускать новый экземпляр.

Узлы definition (типы delay-режимов и waitEvent):

```json
{
  "start_node": "n1",
  "nodes": [
    { "id": "n1", "type": "sms", "name": "SMS 1", "templateId": "...", "senderName": null, "next": "n2" },
    { "id": "n2", "type": "waitEvent", "name": "Ждём заявку", "event": "APPLICATION_APPROVED",
      "timeoutHours": 72, "timeoutMinutes": 0, "onEvent": "n3", "onTimeout": "n5" },
    { "id": "n3", "type": "sms", "templateId": "...", "next": null },
    { "id": "n5", "type": "delay", "name": "До 10:00", "hours": 0, "minutes": 0,
      "mode": "until_time", "atHour": 10, "atMinute": 0, "next": "n6" },
    { "id": "n6", "type": "sms", "templateId": "...", "next": null }
  ]
}
```

- `waitEvent` — ожидание события клиента (из 18 триггерных) с таймаутом: пришло событие → ветка `onEvent` (null = завершить; контекст экземпляра обновляется свежим payload события); таймаут → ветка `onTimeout`; таймаут обязан быть > 0; обе ветки null одновременно — ошибка валидации.
- `delay.mode` — `relative` (по умолчанию: `hours`/`minutes` от текущего момента) | `until_time` (`atHour`/`atMinute` — до следующего наступления времени, по местному поясу клиента) | `until_date` (`atDate` «ГГГГ-ММ-ДД» + `atHour`/`atMinute`; прошедшая дата — шаг пропускается) | `until_birthday` (до ближайшего дня рождения клиента в `atHour`:`atMinute` его поясом; нет ДР — шаг пропускается).

## Events (приём от системы данных)

- `POST /events` — заголовок `X-Api-Key`. Тело `{event, external_id, payload?, client_card?, idempotency_key?, skip_triggers?}` → **202** `{"eventId":"<uuid>","duplicate":false}`. События (18; единый реестр и статусный маппинг — `engine/types.ts`): LOAN_OVERDUE, PAYMENT_DUE_SOON, PAYMENT_RECEIVED, LOAN_CLOSED, BIRTHDAY, APPLICATION_APPROVED, APPLICATION_REJECTED, APPLICATION_CREATED (ст. 5), APPLICATION_IN_REVIEW (ст. 6), APPLICATION_ON_REVISION (ст. 9309), APPLICATION_CLIENT_DECLINED (ст. 10), APPLICATION_DECLINED_AFTER_APPROVAL (ст. 21), APPLICATION_PROCESSING_EXPIRED (ст. 710 «истёк срок оформления»), APPROVAL_EXPIRED (ст. 711 «истёк срок одобрения»), LOAN_ISSUED (ст. 13), LOAN_PROLONGED (ст. 17), EARLY_PAYMENT_MADE (ЧДП), PREAPPROVE_ISSUED (иначе 422). Ключ: статический env `EVENTS_API_KEY` ИЛИ ключ из таблицы ApiKey (sha256, isActive, IP-allowlist, пер-ключевой лимит rateLimitPerMin). 401 при неверном ключе. Обработка асинхронная (воркер), дедуп по idempotency_key. `skip_triggers=true` — «только upsert карточки» без запуска воронок и пробуждения waitEvent (семантика profiles/import legacy; ускоренный поток импорта воркера, 2000 строк/тик).
- Лимиты приёма (G6, env): пре-авторизационный IP `EVENTS_IP_RATE_LIMIT_PER_MIN` (дефолт 600/мин) → пер-ключевой ПОСЛЕ сверки: `ApiKey.rateLimitPerMin` либо `EVENTS_KEY_RATE_LIMIT_PER_MIN` (дефолт 120/мин). 429 с указанием лимита в detail.
- **`POST /events/batch`** (интеграция с системой данных, G1) — тот же `X-Api-Key`; тело `{events: [<те же строки, что POST /events>]}` ≤ 10 000 строк, ≤ 10 МБ (как import_batch legacy). Валидация ПОСТРОЧНАЯ: мусорная строка не роняет батч — её ошибка в `results[i]`. → **202** `{accepted, created, duplicates, invalid, results:[{index, eventId?, duplicate?, error?}]}` — адаптер системы данных может повторить только упавшие строки. Дубликаты внутри батча и к БД — `duplicate:true` с eventId существующей строки. Пер-ключевой лимит батч-запросов: `ApiKey.rateLimitPerMin` либо `EVENTS_BATCH_KEY_RATE_LIMIT_PER_MIN` (дефолт 60/мин → до 600 тыс. строк/мин). 422: не массив / пусто / > 10 000; 413 — тело. Радар неизвестных полей агрегируется ОДНИМ upsert на ключ за весь батч.
- `client_card` — необязательный объект карточки клиента (все поля из таблицы выше + `phone`, `timezone`). `timezone` — IANA-имя или цифровое смещение UTC (число `5` / `"5"`, `"+5"`, `"-3"`, `"+05:00"`, `"UTC+5"` → нормализация в IANA-зону; раньше число валило карточку). Воркер ДО поиска воронок делает upsert: клиент найден → частичное обновление переданных полей (невалидный phone/timezone — игнорируются, не падаем); не найден → создание, если в карточке есть валидный `phone` (timezone из карточки или дефолт), иначе `clientNotFound`. `profileUpdatedAt` = `date_update` из карточки, иначе now(). Флаги `clientCreated`/`clientUpdated` пишутся в result события. Событие хранится в payload КАК ЕСТЬ + каноничные `cf_<key>`-ключи кастомных полей в `client_card` — `client_card` остаётся в payload экземпляра воронки (timezone — в нормализованном виде).
- **Кастомные поля в client_card**: ключи `cf_<key>` (канонично), сырой `<key>`, camelCase-написание контракта системы данных (`isCreditLine` → `is_credit_line`) ИЛИ нормализованная форма без регистра/подчёркиваний (`isSravni_client` ≡ `is_sravni_client` — доработка №4 «Сравни» передаёт именно так) для ЗАРЕГИСТРИРОВАННЫХ активных полей — значения нормализуются по типу и применяются воркером к профилю ДО запуска воронок (итог в result события: `cfApplied` — записей, `cfSkipped` — ключи с невалидным значением). Ключи `cf_…` без зарегистрированного поля — попадают в радар (кто-то шлёт в наше пространство имён незарегистрированное поле). Зарегистрированные (включая деактивированные) ключи — во всех написаниях — неизвестными НЕ считаются. Реестр «полей доработок ч.1–4» (13 полей: даты закрытия/авторизации, скоринг, самозанятость, выплаты, просрочки, отклонённые заявки, Сравни и др.) регистрируется автоматически при бутстрапе БД (`db-bootstrap.ts`, `registry/core-cf-seed.ts`) и уже применён на существующей базе (`scripts/register-core-fields.ts`).
- Перед запуском воронок воркер ПРОБУЖДАЕТ WAITING-экземпляры, ожидающие это событие (узлы waitEvent): таймаут-задачи отменяются, контекст обновляется свежим payload, продолжение по ветке onEvent; список пробуждённых — в result события (`wokenEvents: [{instanceId, funnelId}]`). Пропуски по режимам входа — `skipped: SKIPPED_ACTIVE_EXISTS | SKIPPED_ALREADY_PASSED`.
- Переменные шаблонов: `vars = {...карточка клиента, ...client.data, ...payload, ...кастомные поля cf_*}` (кастомные — из профиля, применённого до запуска воронки; приоритет в этом порядке); в условиях воронки доступны `client.*` (включая `client.cf_<key>`), `payload.*`, `vars.*` и ГОЛЫЕ имена переменных (`agreement_actual_status == 19`). Даты карточки и кастомных дат в переменных — строки «дд.мм.гггг».
- `GET /events?page=&pageSize=&status=&event=` (сессия) — items `{id, event, externalId, status, result?, unknownFields?, source, createdAt}`. Статус inbox: NEW | PROCESSING | PROCESSED | FAILED (PROCESSING — кратковременный claim воркера; зависший после сбоя PROCESSING автоматически переобрабатывается через 5 минут). `unknownFields` — JSON-массив имён полей из `client_card`, которых нет в схеме карточки («радар» доработок системы данных, заполняется при приёме; null — все ключи известны).
- **«Радар» неизвестных полей** — система данных дорабатывает выгрузку и начинает передавать в `client_card` поля, которых нет в схеме (единый реестр `registry/card-fields`). zod отбрасывает такие ключи молча — радар фиксирует их при приёме ПО СЫРОМУ объекту: `EventsInbox.unknownFields` (детали по событию) + агрегат `UnknownFieldObservation` (сводка: счётчик, первое/последнее упоминание, тип события). Пока поле не подключено в реестр, радар загорается снова после удаления наблюдения — дыра в схеме не замалчивается. Неизвестные поля НЕ роняют приём (202) и не влияют на обработку события воркером.
- `GET /events/unknown-fields` (сессия) — сводка радара: `{items: [{fieldName, count, firstSeenAt, lastSeenAt, lastEventId, lastEventName}]}`, свежие сверху. UI: амбер-алерт в журнале событий + пометки «вне схемы: …» у строк.
- `DELETE /events/unknown-fields/{fieldName}` (сессия ADMIN) — убрать наблюдение из сводки (после подключения поля в реестр или решения игнорировать). → 204; 404 — наблюдения нет. Аудит DELETE/EVENT. Новое наблюдение того же поля воссоздаст строку.
- `POST /events/test` (сессия MANAGER+) — то же тело (включая client_card), без API-ключа, source=PANEL → 202 `{eventId}`. Dev-ручная отправка.
- `POST /events/{id}/retry` (сессия MANAGER+) — повторная обработка упавшего события. Сброс FAILED → NEW (error/result очищаются), воркер подхватывает в ближайший тик (≤5 с). → 200 `{id, event, externalId, status:"NEW", ...}`. 404 — события нет; 409 — статус не FAILED; защита от дублей экземпляров — штатные режимы повторного входа воронок. Аудит RETRY/EVENT. UI: кнопка «Повторить» в журнале + фильтр статуса.

## Instances (экземпляры воронок)

- `GET /instances?status=&funnelId=&clientId=&search=&page=&pageSize=` — items `{id, funnelName, funnelVersion, client:{id,externalId,phone}, status, currentNodeId, error, createdAt, updatedAt}`.
- `GET /instances/{id}` → `{instance:{...}, funnel:{id,name}, client:{...}, timeline:[{id,type,nodeId,nodeType,message,createdAt}], messages:[smsMessage...]}` — timeline asc, messages desc. Типы таймлайна: STATUS_CHANGE | NODE_START | NODE_DONE | SMS_SENT | SMS_REJECTED | SMS_FAILED | ERROR | INFO | WAIT_EVENT_RECEIVED | WAIT_EVENT_TIMEOUT (П5).
- `POST /instances/{id}/cancel` (MANAGER+) → 200 item.

## SMS-лог

- `GET /sms?status=&search=&from=&to=&page=&pageSize=` — items `{id, phone, body, segments, provider, providerMessageId, priceKopecks?, operatorCode?, templateName, status, rejectReason, error, varsSnapshot, sentAt, deliveredAt, createdAt, clientExternalId?}`. priceKopecks/operatorCode — тарификация и оператор из webhook-уведомлений SMS.Tech (в UI — карточка сообщения и бейдж оператора у провайдера). **varsSnapshot (P6)** — снимок переменных сообщения `{имя: значение|null}`: только переменные, реально использованные шаблоном, со значениями на момент рендера (null — переменной не было: сработал дефолт/плейсхолдер; значения свыше 200 симв. усекаются). Пишется во ВСЕ исходы (отправлено/отклонено/отменено/упало) — в карточке сообщения видно, что именно подставилось; в карточке клиента — то же поле в деталях истории SMS.
- `GET /sms/export?status=&search=&from=&to=` → `text/csv` (attachment `sms_log_<date>.csv`; BOM; `;`).

## Unsubscribed

- `GET /unsubscribed?page=&pageSize=&search=` — items `{id, phone, source, clientId, createdAt}`.
- `POST /unsubscribed` (MANAGER+) `{phone}` (E.164) → 201 `{id, phone, source:"MANUAL", clientId, createdAt}` — операторское внесение в отписку: запись source=MANUAL + client.unsubscribedAt для найденного по телефону клиента. Идемпотентно: существующий номер → 200 с тем же item. Невалидный формат → 422 ProblemDetail.
- `DELETE /unsubscribed/{id}` (MANAGER+) → 204; снимает client.unsubscribedAt при совпадении phone.

Отписка блокирует ТОЛЬКО маркетинговые SMS (шаблоны isMarketing). Сервисные сообщения (напоминания об оплате, статусы, коды) доставляются отписавшимся как обычно; активные экземпляры воронок НЕ отменяются — рекламные SMS-узлы отклоняются комплаенсом по одному.

## Segments

- `GET /segments` → `{items: [{id, name, description, conditions, mode, frozenCount, frozenAt, createdAt, updatedAt}], total}` (сессия). `mode`: `dynamic` (живой пересчёт по условиям) | `static` (фиксированный срез состава).
- `POST /segments` (MANAGER+) `{name, description?, conditions}` → 201. Создаётся динамическим; фиксация — отдельным действием.
- `PUT /segments/{id}` (MANAGER+) — частичное обновление `{name?, description?, conditions?}` → 200. Для `mode=static` изменение `conditions` отклоняется 409 (снимите фиксацию, затем правьте критерии).
- `DELETE /segments/{id}` (MANAGER+) → 204; 409 «Сегмент используется рассылками», если на него ссылается ACTIVE/PAUSED-рассылка (DONE/CANCELLED не блокируют).
- `POST /segments/{id}/freeze` (MANAGER+) → 200 — зафиксировать/обновить состав: текущие подходящие под условия клиенты материализуются в срез (`SegmentMember`); `mode` → `static`, у сегмента появляются `frozenCount`/`frozenAt`. Повторный вызов = «обновить срез» (старый состав заменяется). Рассылки по фиксированному сегменту идут ровно по срезу.
- `POST /segments/{id}/unfreeze` (MANAGER+) → 200 — снять фиксацию: срез удаляется, `mode` → `dynamic` (живой пересчёт). Для нефиксированного сегмента → 409.
- `POST /segments/preview` (MANAGER+) `{conditions, sampleSize? (1..50, по умолчанию 20)}` → `{total, sample: [{id, externalId, fullName, phone, agreementStatus, lastProductType, smsConsentStatus, notificationActive, birthday, offerApproveMoney, offerDateExpired}]}` — вычисление без сохранения.
- `GET /segments/{id}/clients?page=&pageSize=` — постраничный предпросмотр + точный `total`; для `dynamic` — вычисление по условиям (SQL-счёт/пагинация для стандартных правил, курсорные порции для спец-правил — база в миллионы строк не материализуется), для `static` — страницы из среза.
- `GET /segments/{id}/count` → `{total, mode, computedAt, frozenAt}` — динамический: точный живой счёт (кэш 5 мин, инвалидируется правкой/удалением/фиксацией); фиксированный: размер среза (мгновенный COUNT по индексу, каскадно уменьшается при удалении клиентов). Для больших баз — основной способ узнать размер сегмента.

Формат `conditions` (поля — имена полей карточки, см. реестр `src/lib/segments/fields.ts`; плюс `cf_<key>` кастомных полей — категория «Кастомные», динамический реестр из БД):

```json
{
  "match": "all",            // all = И, any = ИЛИ
  "rules": [
    { "field": "agreement_actual_status", "op": "eq", "value": 19 },
    { "field": "person_offer_date_expired", "op": "within_next_days", "value": 14 },
    { "field": "cf_vip_level", "op": "eq", "value": "gold" }
  ]
}
```

Операторы по типам полей:
- числа (статусы, суммы, счётчики, ID): `eq | neq | gt | gte | lt | lte`;
- строки (ФИО, e-mail): `eq | neq | contains`;
- enum (`last_product_type`, `sms_consent_status`): `eq | neq | in` (value — строка или список);
- булевы (`notification_active`, `person_offer_available`, `unsubscribed`, кастомные `cf_*` типа bool): `eq` (value true/false);
- даты (`person_offer_date_start/expired`, `date_update`, кастомные `cf_*` типа date): `within_next_days | within_last_days | older_than_days` (value — число дней), `before_date | after_date` (value — «ГГГГ-ММ-ДД»);
- `person_birthday`: `birthday_within_next_days` (месяц/день без года, переход через 31 декабря), `age_gt | age_gte | age_lt | age_lte` (полных лет);
- кастомные `cf_<key>`: операторы соответствуют ТИПУ поля (text → строковые, number → числовые, date → датные, bool — eq); вычисление — SQL EXISTS-подзапросом по индексам `(fieldId, value*)`, без JS-прохода по базе.

Семантика: пустые (null/отсутствующие) поля не совпадают ни с одним оператором, включая `neq` (как в SQL); у кастомного поля «нет значения» = строки ClientFieldValue нет. `unsubscribed=true` = отписка ИЛИ номер в стоп-листе. Некорректные правила → 422 ProblemDetail с указанием критерия.

## Broadcasts — рассылки по сегментам

- `GET /broadcasts` → `{items: [BroadcastDto], total}` — каждой карточке `segmentName/templateName`, `nextRunAt`, статистика последнего запуска `lastRun` (сессия).
- `POST /broadcasts` (MANAGER+) → 201. Тело:
  ```json
  {
    "name": "Преапрув недели",
    "description": "…",
    "segmentId": "…",
    "templateId": "…",
    "kind": "ONCE",              // ONCE | RECURRING
    "runNow": true,              // ONCE: отправить немедленно
    "runAtLocal": "2026-10-25T14:00",  // ONCE: стеночное время (по местному поясу КАЖДОГО клиента); нельзя вместе с runNow
    "weekday": 1,                // RECURRING: 1=Пн..7=Вс
    "hour": 10, "minute": 0,     // RECURRING: местное время клиента
    "minDaysBetween": 7,         // клиент получает эту рассылку не чаще 1 раза в N дней (окно — от планового времени отправки клиента)
    "maxRecipients": 1000        // порция получателей на запуск (1..100000)
  }
  ```
- `GET /broadcasts/{id}` → BroadcastDto + `runs[]` (последние 20 запусков со статистикой).
- `PUT /broadcasts/{id}` (MANAGER+) — редактирование (ACTIVE/PAUSED/DONE; CANCELLED — терминальная; kind и расписание ONCE не меняются) → 200.
- `DELETE /broadcasts/{id}` (MANAGER+) → 204 — удаление: строка и запуски исчезают из панели, запланированные QUEUED-сообщения → CANCELLED, SMS-история остаётся (имя рассылки отштамповано в сообщениях).
- `POST /broadcasts/{id}/run` (MANAGER+) → 202 `{result: {runId, planned, recipients, skippedGuard, cappedBy}, broadcast}` — запуск прямо сейчас; анти-дубль: не чаще 1 запуска рассылки в минуту (иначе 409).
- `POST /broadcasts/{id}/restart` (MANAGER+) → 202 — перезапуск ЗАВЕРШЁННОЙ (DONE) рассылки: реактивация + немедленный новый запуск (появляется в истории «Запуски» вместе с прежними). Защита «не чаще 1 раза в N дней» действует — недавно получавшие пропускаются (skippedGuard). Редактирование (PUT) для DONE разрешено — правки применяются при перезапуске; CANCELLED остаётся терминальной.
- `POST /broadcasts/{id}/cancel` (MANAGER+) → 200 — терминальная отмена ACTIVE/PAUSED-рассылки: статус CANCELLED (nextRunAt=null), запланированные QUEUED-сообщения → CANCELLED, карточка и история запусков остаются. Для DONE/CANCELLED → 409.

BroadcastDto/runs: `{id, name, description, kind, segmentId, segmentName, templateId, templateName, runAt, weekday, hour, minute, minDaysBetween, maxRecipients, status: ACTIVE|PAUSED|DONE|CANCELLED, nextRunAt, lastRunAt, lastRun?, runs?}`; запуск: `{id, status: RUNNING|DONE|FAILED, planned, recipients, skippedGuard, cappedBy, error, startedAt, finishedAt, stats: {queued, sent, delivered, rejected, failed, cancelled}}`.

Правила:
- шаблоны — только активные маркетинговые; переменные шаблона должны быть полями карточки или кастомными полями профиля (`cf_*`, включая деактивированные — значения могли сохраниться) — иначе 422;
- время расписания трактуется по местному поясу каждого клиента (триггер запуска — самый ранний пояс РФ, Europe/Kaliningrad; сообщения ставятся в очередь до `scheduledFor`);
- тихие часы (маркетинг) сдвигают `scheduledFor` на конец окна;
- «не чаще 1 раза в N дней» считается по плановому времени отправки клиента: предыдущая отправка + N дней ≤ новый scheduledFor (учитываются sentAt фактических, scheduledFor висящей очереди, createdAt старых строк; минутный допуск на джиттер воркера);
- отправка идёт через общий комплаенс-пайплайн в момент фактической отправки (отписка/согласие/лимиты могли измениться);
- `POST /broadcasts/{id}/pause` / `POST /broadcasts/{id}/resume` (MANAGER+) — полная заморозка (не запускаются новые запуски, очередь ждёт — сообщения PAUSED-рассылки не выбираются воркером вовсе, не занимая очередь отправки) / возобновление → 200. resume для ONCE с уже случившимся запуском (lastRunAt) финализирует рассылку в DONE — очередь дозаправляется без нового запуска; ни разу не запускавшаяся ONCE возобновляется по расписанию (runAt) либо немедленно;
- unexpected-ошибки отправки ретраятся со счётчиком attempts и backoff 2 мин; после 5 попыток — FAILED;
- sms-лог: у сообщений рассылки появляются `broadcastId/runId/scheduledFor` и статус `CANCELLED` (отменённые).

## Users (ADMIN)

- `GET /users` items `{id, email, name, role, isActive, mustChangePassword, failedLoginCount, lockedUntil, createdAt}`.
- `POST /users` `{email, name?, role, password, mustChangePassword?}` → 201.
- `PUT /users/{id}` `{name?, role?, isActive?, mustChangePassword?}` → 200.
- `POST /users/{id}/password` `{newPassword}` → 204.
- `DELETE /users/{id}` → 204 (нельзя удалить себя — 409).

## API keys (ADMIN)

- `GET /api-keys` items `{id, name, prefix, ipAllowlist, rateLimitPerMin, isActive, lastUsedAt, createdAt, revokedAt}`.
- `POST /api-keys` `{name, ipAllowlist?, rateLimitPerMin?}` → 201 `{id, name, prefix, rateLimitPerMin, key:"evt_..."}` — ключ показывается РОВНО ОДИН раз. `rateLimitPerMin` (1..100000) — повышенный пер-ключевой лимит запросов/мин приёма событий для интеграционного ключа адаптера системы данных (null/не задан — общий дефолт env EVENTS_KEY_RATE_LIMIT_PER_MIN, 120/мин).
- `PUT /api-keys/{id}` `{rateLimitPerMin: 600 | null}` (ADMIN) → 200 `{id, rateLimitPerMin}` — смена лимита без перевыпуска ключа; null — вернуть общий дефолт. 404 — ключа нет; 422 — значение вне 1..100000. Аудит UPDATE/API_KEY (старое и новое значение).
- `DELETE /api-keys/{id}` → 204 (отзыв).

## Обратный поток событий (форвардер, ADMIN/MANAGER)

Обратный поток (G3): события РЕАЛЬНЫХ отправок (send_sms/deliv_sms/undeliv_sms, источник panel/mts/t2/smstech, провайдер ≠ sandbox) батчатся и POST-ятся на endpoint приёмника событий (далее → BI) в формате обмена событиями 1:1. Доставка at-least-once: очередь MessageEvent (forwardedAt/forwardAttempts/forwardError/nextForwardAt/forwardSkip), тик воркера каждые 15 с, ретраи 15с×4 → 5м → 15м → 1ч; дедуп на стороне приёмника по event_type+message_id. Включение тумблера помечает накопленные события forwardSkip (в BI летит с момента включения).

- `GET /integrations/forwarder` (сессия) → `{enabled, url, tokenSet, tokenHint, batchSize, eventTypes, authHeader, pending, skipped, inRetry, forwarded24h, lastSuccessAt, lastErrorAt, lastError}` — токен наружу НЕ отдаётся (маска/факт, AES-256-GCM в БД).
- `PUT /integrations/forwarder` (ADMIN, лимит секретов 20/мин) `{url, token?, batchSize?}` → 200 конфиг. URL http(s) ≤ 500; token: строка — задать/заменить (в ответ не возвращается), null — удалить, пустая строка/нет — не менять; batchSize 10..2000. 422 — URL не http(s).
- `POST /integrations/forwarder` (ADMIN, лимит секретов) `{enabled}` → 200 `{enabled, skippedBacklog}`. Включение: требует URL (иначе 422) и помечает накопленную очередь forwardSkip. Выключение: очередь замирает до следующего включения.
- `POST /integrations/forwarder/test` (MANAGER+) — синпетическое send_sms прямо в URL (мимо очереди) → 200 `{ok, url, tokenAttached, error?, sentAt}`; ok=false — приёмник ответил не-2xx/сеть. Аудит RUN/SETTINGS.

## Статус интеграции (наблюдаемость, G7)

- `GET /integrations/status` (сессия) → `{generatedAt, inbox:{new,processing,failed,processed24h,failed24h,lastIngestAt,lastIngestEvent,oldestNewAt,lagSeconds}, imports:{pending,processed24h}, funnels:{active}, broadcasts:{active,smsQueued,smsSending,smsDue}, sms:{sent24h,delivered24h,failed24h}, forwarder:{...}, worker:{lastTickAt,tickCount,lastTickAgoSeconds}, provider}` — снимок здоровья конвейера «система данных → Trigger → провайдер → BI» для карточки «Интеграция с системой данных» (обновление 15 с) и мониторинга (zabbix-экспорт: числа/секунды). lagSeconds — возраст старейшего NEW-события (норма < 15 с).

## Аудит (ADMIN)

- `GET /audit?limit=30` → `{items:[{id, action, entityType, entityId, userEmail, ip, details, createdAt}], total}` — последние записи журнала аудита (`createdAt` desc). `limit` — кламп 1..200, дефолт 30 (NaN/мусор → 30); смещения нет — читаются последние N записей. `details` — JSON-строка без секретов (клиент парсит сам). Экран: «Настройки» → карточка «Журнал аудита».

## Дистрибутив (вкладка «Документация», ADMIN)

Архив дистрибутива содержит полный серверный код панели — оба эндпоинта доступны только ADMIN.

- `GET /distributive/info` → `{version, date, sizeBytes, sha256, exists, src:{filename, sizeBytes, sha256}|null, repo:{filename, sizeBytes, sha256}|null, public:{filename, sizeBytes, sha256}|null}` — манифест `download/latest.json` (собирает `deploy/build-archive.sh`); `exists:false` — дистрибутив не собран, `src` — лёгкий архив исходников, `repo` — git-бандл репозитория (чистый снапшот кода), `public` — публичный архив для GitHub (тот же снапшот + каталог `.git`, «push-ready»; блоки появились в свежих сборках).
- `GET /distributive?type=full|src|repo|public` — скачивание архива (`full` — standalone-бандл, по умолчанию; `src` — исходники; `repo` — git-бандл, клонируется `git clone <файл>.bundle`; `public` — zip-архив для GitHub, распаковывается как готовый локальный репозиторий с `.git`). Файл отдаётся ПОТОКОМ (без чтения в память), заголовки: `Content-Type` (`application/gzip` для tar.gz, `application/zip` для zip, `application/octet-stream` для бандла), `Content-Disposition: attachment`, `X-Checksum-Sha256` — контрольная сумма. 404 — архив не собран/файл из манифеста отсутствует; 409 «Архив изменён» — размер файла не совпадает с манифестом (пересоберите дистрибутив).

## Settings (чтение — все; запись — ADMIN)

- `GET /settings` → `{advertiserName, quietHoursStart, quietHoursEnd, dailyClientLimit, systemDailyLimit, provider, unsubscribeBaseUrl, defaultTimezone, defaultSenderName, useShortLinks, marketingDisclaimer, inboxRetentionDays, messageEventRetentionDays}` (defaultSenderName — имя отправителя SMS по умолчанию, латиница/цифры/дефис ≤ 20; useShortLinks — короткие ссылки отписки, marketingDisclaimer — шаблон приписки; inboxRetentionDays — сколько дней хранить обработанные события inbox и завершённые задачи scheduled_jobs, 0 = не удалять, дефолт 30; provider — sandbox | smstech | t2 | mts).
- `PUT /settings` (ADMIN) → 200. Поля: `useShortLinks` (boolean) и `marketingDisclaimer` (строка ≤ 300; пусто = стандартный текст «Реклама. {advertiser}. Отказаться: {link}»). Поле: `inboxRetentionDays` (int 0..3650). Поле: `messageEventRetentionDays` (int 0..3650, дефолт 0 = не удалять) — ретеншн журнала MessageEvent (Task 63): воркер раз в 5 минут выгружает события доставки старше N дней в gz-архив db/message-events-archive/ (JSONL, месячная ротация) и удаляет из БД; при включённом форвардере очередь (forwardedAt IS NULL AND forwardSkip = false) не удаляется; после больших удалений — VACUUM при freelist > 512 МБ (раз в сутки). Воркер раз в 5 минут удаляет PROCESSED/DUPLICATE-события и терминальные задачи (DONE/CANCELLED/FAILED) старше N дней; FAILED-события автоматически НЕ удаляются. Валидация приписки: плейсхолдеры — только `{link}` (обязателен — иначе клиент не сможет отписаться) и `{advertiser}`; неизвестный или отсутствующий → 422 ProblemDetail.

## Короткие ссылки и приписка

Персональная короткая ссылка отписки вместо полной с HMAC-токеном:

- Ссылка в SMS: `{base}/?u={код}` — 7 символов из алфавита без похожих глифов (без 0/O/1/l/I) вместо `?unsub=<~86 симв. токена>` — экономия ~80 символов (обычно минус одна часть SMS при UCS-2).
- Модель ShortLink: `{code, kind:"UNSUBSCRIBE", token — полный HMAC-токен, clientId, visits — счётчик переходов, lastVisitAt, expiresAt — срок токена 180 дней}`; создаётся при отправке каждого маркетингового SMS (воронка/рассылка), протухшие чистятся воркером через 30 дней после истечения.
- Приписка маркетинговых SMS — редактируемый шаблон из настроек: `{link}` подставляется персональная ссылка, `{advertiser}` — название рекламодателя. Итог: `${тело} ${приписка}`; лимит частей считается по итоговому тексту с припиской.
- Приписка и ссылка используются во всех точках: SMS-узел воронки, рассылки (фиксация при создании очереди), превью шаблона (sample-код `Xk3fQ9a`, БЕЗ записи в БД), живой предпросмотр редактора шаблонов и настроек.
- `GET /short-links/stats` (сессия) → `{total, total30d, visited, visits, last30dVisits, unsubscribed30d, unsubscribedTotal}` — статистика для карточки настроек (по редирект-логу).

## Именные короткие ссылки

Маркетинговые ссылки с UTM-метками и подсчётом переходов (расширение коротких ссылок отписки):

- Модель ShortLink kind=LINK: `{code, name, targetUrl — итоговый URL с UTM, expiresAt — null = бессрочная, visits, lastVisitAt}`; ссылка в SMS: `{base}/r?c={code}`. Каждый переход — строка ShortLinkVisit (редирект-лог, история по дням).
- `GET /links` (сессия) → `{items:[{id, code, name, targetUrl, expiresAt, visits, lastVisitAt, smsCount — сколько отправленных SMS содержат код, createdAt, updatedAt}]}`.
- `POST /links` (MANAGER+) `{name 1-80, targetUrl http(s) ≤500, utm{utm_source…utm_term ≤100}, expiresAt "ГГГГ-ММ-ДД"?}` → 201 объект ссылки; не-URL → 422.
- `PUT /links/{id}` — те же поля; КОД СОХРАНЯЕТСЯ (QR/печать не ломаются). `DELETE /links/{id}` → 204. Аудит SHORT_LINK.
- UTM-механика: метки дописываются к targetUrl (одноимённые существующие — заменяются, пустые — убираются); при редактировании URL разбирается обратно на «чистый» адрес + метки.

## Интеграции SMS-провайдеров

Предустановленные подключения (экран «Интеграции»): карточки провайдеров со статусами (Активен/Подключён/Требует настройки), упрощённые формы подключения SMS.Tech (поле «Токен доступа»), Т2 «Бизнес SMS» (поля «Логин/Пароль» с сохранением на сервере) и МТС OmniChannel (поля «Логин/Пароль», system_id из договора), webhook-URL для передачи в поддержку провайдера/менеджеру МТС. Секреты в панель не отдаются — только факт наличия.

- `GET /integrations` (сессия) → `{activeProvider, providers:[{id: smstech|t2|mts|sandbox, displayName, kind: aggregator|operator|sandbox, title, description, active, configured, registeredSenderName?, defaultSenderName, webhook:{path, url, secretSet, method}, envKeys:{webhookSecret}, cabinetUrl, limits:{segmentGsm7?, segmentUcs2?, perPhonePerHour?, recommendedRps?, statusWaitDays?}}]}` — webhook.url строится от Origin запроса. configured: smstech = токен сохранён в панели (AppSettings.smstechToken) ИЛИ env SMSTECH_ACCESS_TOKEN; t2 = логин/пароль сохранены (AppSettings.t2Login/t2Password) ИЛИ env T2_LOGIN/T2_PASSWORD; mts = логин/пароль сохранены (AppSettings.mtsLogin/mtsPassword) ИЛИ env MTS_LOGIN/MTS_PASSWORD.
- `POST /integrations/smstech/token` (ADMIN) `{token: string ≤ 512 (8+ или "" для очистки)}` → `{ok: true, tokenSet}` — сохранение/замена/удаление токена доступа SMS.Tech (поле «Токен доступа»). Токен пишется в AppSettings.smstechToken, в ответе/аудите не возвращается (только длина). Аудит ACTIVATE/SETTINGS.
- `POST /integrations/t2/credentials` (ADMIN) `{login: string ≤ 128 (2+ или ""), password: string ≤ 128 (4+ или "")}` → `{ok: true, credentialsSet}` — сохранение/замена/удаление логина/пароля подключения Т2 (оба поля пустыми = удалить; частичный ввод — 422). Пишутся в AppSettings.t2Login/t2Password, в ответе/аудите не возвращаются. Аудит ACTIVATE/SETTINGS. Лимит 20 операций/мин с IP.
- `POST /integrations/mts/credentials` (ADMIN) `{login: string ≤ 128 (2+ или ""), password: string ≤ 128 (4+ или "")}` → `{ok: true, credentialsSet}` — сохранение/замена/удаление логина (system_id из договора) и пароля подключения МТС OmniChannel (оба поля пустыми = удалить; частичный ввод — 422). Пишутся в AppSettings.mtsLogin/mtsPassword, в ответе/аудите не возвращаются; шифрование AES-256-GCM. Аудит ACTIVATE (сохранение) / DELETE (очистка). Лимит 20 операций/мин с IP.
- `POST /integrations/activate` (ADMIN) `{provider: sandbox|smstech|t2|mts, senderName?}` → 200 `{provider, defaultSenderName}`; для smstech: 422 если токен не сохранён или пустое имя отправителя; для t2: 422 если креды не сохранены или имя отправителя не соответствует формату shortcode (латиница/цифры, ≤ 11); для mts: 422 если креды не сохранены или имя отправителя (нейминг sms_address) не соответствует формату (латиница/цифры/дефис, ≤ 11). Аудит ACTIVATE/SETTINGS.
- `POST /integrations/t2/check` (ADMIN) `{}` → `{ok, detail}` — БЕСПЛАТНАЯ проверка подключения Т2: operation=status по несуществующей транзакции (раздел 6 документа Т2) отличает «логин/пароль неверны» от «креды приняты».
- `POST /integrations/t2/test` (ADMIN) `{phone, text? ≤ 480, sender? ≤ 11}` → `{ok, code, segments, smsId, error}` — реальная тестовая отправка через Т2; строка в SMS-логе (templateName «Тест Т2») + аудит. Некорректный номер/имя → 422.
- `POST /integrations/mts/check` (ADMIN) `{}` → `{ok, detail}` — БЕСПЛАТНАЯ проверка подключения МТС OmniChannel: POST /messages/info с пустым int_ids — на живом шлюзе креды проверяются ДО валидации тела, отличает «логин/пароль неверны» (HTTP 400 + код 804 с сообщением Bad credentials — живой шлюз отвечает 804 там, где документация V.1.14 описывает 802; сообщение надёжнее кода) от «креды приняты» (HTTP 422/код 602/612 «…in body…»/200). При отказе текст включает подсказку: system_id из договора, активация у менеджера МТС, IP-ограничения шлюза.
- `POST /integrations/mts/test` (ADMIN) `{phone, text? ≤ 480, sender? ≤ 11}` → `{ok, code (internal_id), segments, smsId, error}` — реальная тестовая отправка через МТС (тарификация); строка в SMS-логе (templateName «Тест МТС») + аудит. Некорректный номер/имя → 422; лимит 5 тестов/мин с IP.
- `POST /integrations/smstech/check` (ADMIN) `{phone?}` → `{ok, detail, operator?, normalizedPhone?}` — БЕСПЛАТНАЯ проверка подключения через ResolveOperators (раздел 12 документации SMS.Tech): отличает «токен неверен» (401) от «шлюз доступен» (200 + оператор номера).
- `POST /integrations/smstech/test` (ADMIN) `{phone, text? ≤ 480, sender?}` → `{ok, code, segments, smsId, error}` — реальная тестовая отправка через SMS.Tech; строка в SMS-логе (templateName «Тест SMS.Tech») + аудит. Некорректный номер → 422.

### Провайдер smstech

Реализация по официальной документации «SMS.Tech — HTTP API шлюза отправки сообщений» v2.0 (sms-gate.smsleads.ru):

- Отправка: `POST /api/v1/grpc/SmsService/SendMessage` — meta `{access_token (токен из AppSettings.smstechToken либо env SMSTECH_ACCESS_TOKEN), idempotency_key}` + data `{recipient, sender_name, text, channel:"sms", tags}`. Идемпотентный ключ — детерминированный UUID из стабильного контекста (`funnel:<instanceId>:<nodeId>` для воронок, `broadcast:<smsId>` для рассылок, `test:<userId>:<ts>` для тестов): ретраи после таймаутов/HTTP 500 повторяют запрос С ТЕМ ЖЕ ключом и не создают дублей (раздел 6/16.1). В data — только задокументированные поля (лишние → HTTP 500, раздел 3).
- Статусы: `GetMessageByCode` — маппинг MESSAGE_STATUS_SEND → SENT, MESSAGE_STATUS_DELIVERED → DELIVERED, MESSAGE_STATUS_SEND_ERROR → FAILED, отсутствие status → QUEUED (раздел 9).
- Ошибки: сеть/таймаут/5xx → TemporaryProviderError (ретраи движком с backoff, ключ сохраняется); 4xx — постоянные: текст из Google API error model (code + message + details[].fieldViolations), 402 → «Недостаточно средств… hub.sms.tech». Отправленные через tags: `trigger` + имя шаблона (аналитика в кабинете агрегатора).
- segmentsCount из ответа шлюза пишется в sms_messages.segments (биллинговая точность выше локального расчёта).

### Провайдер t2 — Т2 «Бизнес SMS»

Реализация по официальному документу «Услуга "Бизнес SMS". Использование протоколов HTTP/SMTP» (upload/http_connect.pdf):

- Авторизация: логин/пароль HTTP-рассылки (AppSettings.t2Login/t2Password либо env T2_LOGIN/T2_PASSWORD) в query каждого запроса (раздел 4). Выдаются в ЛК bsms.t2.ru при создании HTTP-рассылки.
- Отправка: `GET {T2_BASE_URL|https://bsms.t2.ru}/api/?operation=send&login&password&msisdn=79XXXXXXXXX&shortcode&text&format=ext&ptag=trigger&ext_id` — msisdn строго 11 цифр, shortcode ≤ 11 ASCII, URL-кодировка через URLSearchParams. Ответ JSON `{"code":0,"data":{"id":<транзакция>}}` → ok, id → providerMessageId; `{"code":-1,"message":"ERROR: …"}` → ошибка. ext_id — целое число из sha256(idempotencyScope), «предотвращает повторную отправку» (раздел 4): ретраи не создают дублей.
- Временные ошибки (ретраи движком): сеть/таймаут, «system error», «throttling error» (раздел 6). Остальные тексты ошибок — постоянные.
- Статусы: `GET …/?operation=status&id=<транзакция>&format=ext` (раздел 6): delivered → DELIVERED; accepted → SENT; enrote/billed/not_sent/unknown → QUEUED; expired/undeliverable/rejected → FAILED. Парсится и plain-text, и JSON: расширенный ответ — ПЛОСКИЙ JSON `{transaction_id, status, parts[…], …}` (без обёртки code/data — она только у ответа на send), статус берётся из поля `status`.
- Webhook: `GET /webhooks/t2?id&status&parts&transaction_id&ptag&text&abonent&sender&error_codes&delivery_type` (раздел 7 — уведомление партнёра о статусе исходящих): обновляет sms_messages по providerMessageId=id; parts → segments; error_codes ≠ "0" → в error. Гард от понижения: DELIVERED и FAILED — финальные, поздние промежуточные/ошибочные уведомления их не понижают (в result события — statusKept). Опциональная защита: если задан T2_WEBHOOK_SECRET, URL для Т2 должен содержать `?secret=<значение>`; несовпадение → 401. Мусорный запрос (без id/status) → 400; unknown id → `{ok:true, updated:0, reason:"unknown-id"}`; не-финальные статусы (QUEUED-маппинг) → `{ok:true, updated:0, reason:"non-final-status"}`.
- Симулятор для отладки (раздел 10): https://bsms.t2.ru/simulator-api/ — параметры идентичны, реальной отправки нет.

### Провайдер mts — МТС OmniChannel

Реализация по официальному документу «МТС OMNIСHANNEL HTTP API SMS V.1.14» (upload/ «Документация для внешних интеграций по HTTP с каналом SMS.pdf"):

- Авторизация: Basic Authentication (login = system_id из договора, пароль) в заголовке КАЖДОГО запроса (AppSettings.mtsLogin/mtsPassword либо env MTS_LOGIN/MTS_PASSWORD, кэш 30 с). Окружения: PROD https://omnichannel.mts.ru, STAGE-эмулятор через env MTS_BASE_URL (приёмка без реальной отправки).
- Отправка: `POST {MTS_BASE_URL}/http-api/v1/messages` — тело `{messages:[{content:{short_text}, to:[{msisdn, message_id}], from:{sms_address}}]}`; msisdn — строго 11 цифр 7XXXXXXXXXX (нормализация из +7…). Ответ 200 `{messages:[{internal_id, message_id, msisdn}]}` → ok, internal_id → providerMessageId (ключ статусов). message_id — детерминированный UUID из sha256(idempotencyScope): корреляция коллбэков стабильна при ретраях; ВАЖНО — платформа НЕ гарантирует дедупликацию по message_id (в отличие от ext_id Т2), окно дубля ограничено таймаутом всего обмена (10 с).
- Ошибки: 803 (MessageLimit expired — превышена скорость отправки) — ВРЕМЕННАЯ (ретраи движком с backoff); 806/807 приходят с HTTP 200 — перманентная ошибка конкретного получателя; 802/401 — креды; 804/805/808/602 — перманентные; 5xx/таймаут/сеть → TemporaryProviderError. Поведение живого шлюза (проверено 03.11.2026): на /messages/info отказ кредов приходит с кодом 804 и сообщением Bad credentials (в таблице V.1.14 отказ кредов — 802, а 804 = «content is required»), валидация тела — с кодом 612 «…should have at least 1 items» (документирован 602); на /messages отказ кредов — 802. Приоритет — сообщению, а не коду.
- Статусы: `POST /http-api/v1/messages/info` `{int_ids:[providerMessageId]}` (до 500 id) → `{events_info:[{key, events_info:[{status, event_at, …}]}]}` — события накапливаются: любое 300 → DELIVERED, любое 201/301 → FAILED, иначе последнее по event_at. Маппинг кодов (приложение): 200 → SENT, 202 → SENT (часть сегментов отправлена — не финальный провал), 300 → DELIVERED, 301 → FAILED, 302 → FAILED (часть сегментов доставлена — для комплаенса приравнено к недоставке: ссылка отписки в «отрезанном» сегменте не дошла), 201 → FAILED.
- Webhook: `POST /webhooks/mts` — тело `{items:[{internal_id, status, message_id?, destination?, naming?, event_at?, received_at?, total_parts?, call_direction?, operator_group_id?, internal_errors?}]}` (раздел «Callback»; платформа шлёт на URL из договора, порты 80/443/5070; подписи в протоколе НЕТ — опциональная защита `?secret=<MTS_WEBHOOK_SECRET>` с constant-time сверкой, несовпадение → 401). Идентификация по providerMessageId=internal_id; total_parts → segments; internal_errors ≠ 0 → в текст ошибки. Гвард от понижения: DELIVERED/FAILED — финальные, поздние промежуточные 200/202 их не понижают (в result события — statusKept); DELIVERED — сильнейший факт. Мусорный элемент/unknown internal_id → `{ok:true, updated:0, unknown:N}` (весь запрос не валится; статус-код строкой («300») коэрсится в число); пустой items → 400; больше 1000 элементов → 413 (DoS-защита публичного роута). Rate-limit — настраиваемый env WEBHOOK_RATE_LIMIT_PER_MIN (дефолт 300/мин/IP, боевые пики коллбэков — 2000+); ответ — 200 `{ok, updated, unknown}` (требование документа).
- Лимиты платформы: до 1000 получателей в запросе, до 50 МБ тела, SMS ≤ 10 сегментов (670 симв. кириллицы / 1530 латиницы), ttl ожидания статуса 3 сут.; реконсиляция воркера (SENT+mts старше 2 ч) — симметрично Т2/SMS.Tech.

## Stats (дашборд)

- `GET /stats?days=14` (1…365 — селектор периода дашборда) → `{totals:{sent, delivered, failed, rejected, unsubscribed, activeInstances, waitingJobs, linkClicks — переходы по именным ссылкам за период, unsubLinkVisits — по отписочным, unsubscribedInPeriod — новые отписки за период}, byDay:[{date:"YYYY-MM-DD", sent, delivered, failed, rejected, clicks — все переходы по коротким ссылкам}], recentEvents:[...top5], topFunnels:[{name, count}], topTemplates:[{name, sent, delivered, rejected}] — топ шаблонов за период}`.

## Захват событий доставки

Тумблер `AppSettings.hooksEnabled` (карточка «Захват событий» в «Интеграциях», ADMIN): выключен → приёмник отвечает `OK` без записи, журналирование webhook-ов и реконсиляция не выполняются. Токен `AppSettings.hooksToken` (при включении с пустым токеном — генерируется автоматически; ротация — `POST /hooks/token`).

- `GET /hooks` (сессия) → `{enabled, token, tokenSet, path:"/api/v1/hooks/events", url, method:"POST", eventsTotal, lastEventAt}` — URL приёмника для настройки у отправителя событий.
- `PUT /hooks` (ADMIN) `{enabled:boolean}` → тумблер; при включении без токена — автогенерация. Аудит UPDATE SETTINGS.
- `POST /hooks/token` (ADMIN) — ротация токена (старый URL перестаёт работать). Аудит tokenRotated.
- `POST /hooks/test` (MANAGER+) — тестовое событие deliv_sms через весь конвейер: тело (опционально) `{smsId}` — конкретная SMS (tg_sms_id); без него цель — свежая SMS в полёте (SENT/QUEUED/SENDING), иначе последняя отправлявшаяся (SENT/SENDING/FAILED). Корреляция custom_data.tg_sms_id → статус SMS обновляется, событие в журнале. Подходящих SMS нет → 422 («сначала отправьте тестовую SMS, либо укажите tg_sms_id»). Выключенный захват → 409. Событие о доставке/недоставке по ещё не отправлявшейся SMS (QUEUED/SENDING) статус не меняет — в result события пометка `skipped:"SMS not sent yet (QUEUED)"`.
- `GET /message-events` (сессия) — журнал событий: фильтры `q` (телефон contains), `type` (send_sms|deliv_sms|undeliv_sms|click_sms|uclick_sms|unsub_sms|update), `source` (panel|smstech|t2|mts|external), `period` (0|1|7|30|90 дней), `page`/`pageSize` → `{items:[{id, source, eventType, eventDate, receivedAt, phone, provider, smsMessageId, smsStatus, smsBody (текст нашей SMS или content.sms внешнего события), broadcastName (имя рассылки или campaign_name), templateName (или message_name), campaignName, messageSender (fromnamesms), personId (client_id), undelivCode, undelivMessage, clientId, clientExternalId, clientName, status, result, externalIds, payload}], total, page, pageSize, stats:{...}}`.
- `POST /hooks/events` — ПУБЛИЧНЫЙ приёмник внешних событий. Авторизация: заголовок `Authorization: Bearer {токен}` (предпочтительно — не остаётся в логах доступа) или query `?token={токен}` (совместимость); сравнение timing-safe. Тело — JSON-массив событий или одиночный объект `{event_type, event_date (RFC 3339, наносекунды), account_id, profile_id?, subscription:{channel:"sms", phone} ИЛИ массив таких объектов, event_data:{message_id, campaign_id, launch_id, send_message_id, full_message_id, undeliv_code?, undeliv_message?}, custom_data?{client_id, campaign_name, message_name, content?{sms, fromnamesms}}, content?{sms, fromnamesms} (top-level или внутри custom_data), is_test?}`. Ответ — 200 с телом `OK` (матчит regex `.*OK.*` и пустой); счётчики в заголовках `X-Trigger-Events-*`. Ошибка токена → 401; мусорное тело → 400; батч больше 5000 событий → 413 ProblemDetails «Батч слишком большой» (разбейте отправку: идемпотентность делает ретрай меньшими батчами безопасным); rate-limit — настраиваемый env WEBHOOK_RATE_LIMIT_PER_MIN (дефолт 300/мин) с IP → 429 (применяется ДО чтения настроек — молотилка не нагружает БД). Идемпотентность: дедуп по dedupKey (account + event_type + profile/phone + message_id/send_message_id + event_date) — ретраи отправителя (например, 4×15с) дублей не создают, а разные события одного профиля в одну секунду не склеиваются. `is_test:true` — событие пишется в журнал, но без эффектов (отписка/статусы SMS/корреляция пропускаются, result — пометка «тестовое событие»). Эффекты: `unsub_sms` → отписка (unsubscribe_list source=HOOK + client.unsubscribedAt + аудит); при явной корреляции `custom_data.tg_sms_id` → статус SMS (send→SENT, deliv→DELIVERED, undeliv→FAILED с кодом/текстом из undeliv_code/undeliv_message; для QUEUED/SENDING — статус не трогается, пометка skipped); остальные внешние события — реестр с маппингом полей external_message (campaign_name, person_id=client_id → клиент по externalId, template_name=message_name, message_text=content.sms, message_sender=fromnamesms). Телефонная корреляция НАШИХ SMS не выполняется (ложные совпадения при параллельной отправке через внешний сервис).
- `GET /hooks/events` — самодиагностика приёмника (состояние тумблера/токена, формат, потолок батча).
- Журналирование источников: `panel` — send-пути движка (воронки/рассылки; sandbox-доставка — событие deliv_sms сразу), `smstech`/`t2`/`mts` — webhook-уведомления шлюзов (вместе с прежним обновлением статусов), `external` — внешний захват.
- Реконсиляция (воркер, каждые 3 мин): SMS в SENT старше 2 часов без уведомления → опрос `status()` провайдера; DELIVERED/FAILED применяются + событие в журнал (`result.via:"reconciliation"`). Работает только при включённом тумблере.

## Публичные

- `GET /r?c={code}` — (вне префикса `/api/v1`: путь в корне сайта) редирект по ИМЕННОЙ короткой ссылке → 302 на целевой URL с UTM + запись перехода в редирект-лог; недействительная/истёкшая → 404 HTML «Ссылка недействительна». Rate-limit 60/мин с IP.
- `GET /u?c={code}` — проверка КОРОТКОЙ ссылки → 200 `{ok:true, phone:"+7900***1234", advertiser:"..."}` | 400 `{ok:false, title:"Ссылка недействительна или истекла"}` (неизвестный/протухший код). Переход фиксируется в статистике (visits+1). Rate-limit 60/мин с IP → 429.
- `POST /u?c={code}` — отписка по короткой ссылке → 200 `{ok:true, phone:"..."}`. Идемпотентно; контракт тот же, что у полной ссылки.
- `GET /unsubscribe?t={token}` → 200 `{ok:true, phone:"+7900***1234", advertiser:"..."}` | 400 `{ok:false, title:"..."}`.
- `POST /unsubscribe?t={token}` → 200 `{ok:true, phone:"..."}` — unsubscribe_list + client.unsubscribedAt. Идемпотентно. Экземпляры воронок НЕ отменяются: реклама блокируется на каждом SMS-узле, сервисные продолжают уходить.
- SPA-маршрут публичной страницы — `/`: читает `?u={код}` (короткая ссылка) или `?unsub={токен}` (легаси-ссылки из ранее отправленных SMS).
- `POST /webhooks/smstech` — webhook статусов SMS.Tech. Тело `{message:{code, version, status?, errorText?, dateSend?, dateDelivered?, priceMoney:{units — копейки строкой}, operatorCode?, segmentsCount?}}` (раздел 10.3 документации). Заголовок Authorization (raw или `Bearer <значение>`) проверяется по SMSTECH_WEBHOOK_SECRET; секрет не задан — проверка выключена (у SMS.Tech авторизация опциональна). Дедупликация по паре code+version (10.4): старшие версии применяются, старые/повторные → `{ok:true, updated:0, dedup:true}`; unknown code → `{ok:true, updated:0, reason:"unknown-code"}` (шлюз не должен ретраить). Статусы: SEND→SENT (+sentAt из dateSend), DELIVERED→DELIVERED (+deliveredAt, price→priceKopecks, operatorCode), SEND_ERROR→FAILED (+error=errorText). Гард от понижения: DELIVERED/FAILED — финальные статусы, поздние SEND/SEND_ERROR (в т.ч. без version) их не понижают (в result события — statusKept; тарификация/оператор обновляются). Мусорное тело → 400 (без бесконечных ретраев). Ответ 2xx — требование шлюза (10 сек). Уведомление также журналируется как событие «Захвата событий» (source=smstech, при включённом тумблере).
- `POST /webhooks/smsru` — callback статусов SMS.RU: тело `{sms_id, status, hash}`; подпись md5(`SMSRU_API_ID + sms_id + status + SMSRU_WEBHOOK_SECRET`) — алгоритм ПРОВЕРИТЬ ПО ДОКУМЕНТАЦИИ SMS.RU (адаптер «спящий»: провайдер smsru в реестр не подключён, маршрут — задел на будущее). `SMSRU_API_ID`/`SMSRU_WEBHOOK_SECRET` не заданы → 503 «Webhook не настроен»; неверная подпись → 401; rate-limit 300/мин. Обновляет `sms_messages` по `providerMessageId=sms_id`.
- `POST /webhooks/mts` — коллбэк статусов МТС OmniChannel (раздел «Callback» документа V.1.14): тело `{items:[…]}` (поля и семантика — раздел «Провайдер mts» выше; >1000 элементов → 413). Rate-limit 300/мин/IP; опциональный `?secret=` (MTS_WEBHOOK_SECRET, constant-time — в протоколе МТС подписи нет); мусорное тело/пустой items → 400; unknown internal_id → подтверждение приёма с `unknown:N`. Ответ — 200 `{ok, updated, unknown}` (требование документа). Уведомление также журналируется как событие «Захвата событий» (source=mts, при включённом тумблере).
- `GET /api/health` (вне префикса `/api/v1`) → `{"status":"ok|degraded","db":"ok|fail","worker":"ok|fail","dataSnapshot":"ok|pending|n/a","time":"..."}` — HTTP всегда 200, деградацию читать по телу. `worker` — ок, если последний тик моложе 15 с; `dataSnapshot="pending"` — есть содержательный снапшот в канале сохранности, а живая БД пуста (авто-восстановление не отработало — молчаливая потеря данных исключена). Публичный — для мониторинга/балансировщика.

## Enums

- role: ADMIN | MANAGER | VIEWER
- smsConsentStatus: NONE | PENDING | GRANTED | REVOKED
- instance status: RUNNING | WAITING | COMPLETED | FAILED | CANCELLED
- sms status: QUEUED | SENDING | SENT | DELIVERED | FAILED | REJECTED_BY_COMPLIANCE | CANCELLED
  - SENDING — внутренний claim-статус отправки (кратковременный, восстановление после сбоя — в очередь).
  - Фильтр `GET /sms?status=` принимает только значения из списка; неизвестный статус → 422.
  - Дневные лимиты комплаенса считают только QUEUED/SENDING/SENT/DELIVERED (отменённые и провалившиеся сообщения лимит не расходуют; сообщение рассылки не считает само себя).
- rejectReason: QUIET_HOURS | UNSUBSCRIBED | ADVERT_OFF | NO_CONSENT | LIMIT_CLIENT | LIMIT_SYSTEM | INVALID_PHONE | RENDER_ERROR | SMS_TOO_LONG | TEMPLATE_CANCEL
  - UNSUBSCRIBED/ADVERT_OFF/NO_CONSENT — только для маркетинговых шаблонов; ADVERT_OFF = notification_active=false (аналог person_exclude). Сервисные SMS отклоняются только по INVALID_PHONE/LIMIT_*/RENDER_ERROR.
- provider: sandbox | smstech | t2 | mts
- message event type: send_sms | deliv_sms | undeliv_sms | click_sms | uclick_sms | unsub_sms | update
- message event source: panel | smstech | t2 | mts | external
- unsubscribe source: LINK | MANUAL | IMPORT | HOOK
- trigger events (18, единый реестр — `engine/types.ts` `TRIGGER_EVENTS`): LOAN_OVERDUE | PAYMENT_DUE_SOON | PAYMENT_RECEIVED | LOAN_CLOSED | BIRTHDAY | APPLICATION_APPROVED | APPROVAL_EXPIRED | APPLICATION_REJECTED | PREAPPROVE_ISSUED | APPLICATION_CREATED | APPLICATION_IN_REVIEW | APPLICATION_ON_REVISION | APPLICATION_CLIENT_DECLINED | APPLICATION_DECLINED_AFTER_APPROVAL | APPLICATION_PROCESSING_EXPIRED | LOAN_ISSUED | LOAN_PROLONGED | EARLY_PAYMENT_MADE
- agreement status (справочно): 16 — действующий, 17 — пролонгирован, 19 — закрыт; application status 9 — отказ
