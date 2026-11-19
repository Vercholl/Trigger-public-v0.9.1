// Самобутстрап базы данных: схема (DDL) + стартовый администратор.
//
// ЗАЧЕМ: приложение обязано подниматься в ЛЮБОМ окружении без ручных шагов —
// публикация платформы (контейнер /app/next-service-dist + /app/db/custom.db,
// env задаёт start.sh), standalone-дистрибутив, чистый git-checkout без .env/db.
// «prisma db push» требует CLI, которого нет в standalone-трассировке, поэтому
// DDL пустой схемы встроен сюда константой (сгенерирован командой:
//   bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
// затем CREATE TABLE/INDEX → IF NOT EXISTS; см. scripts/gen-bootstrap-ddl.ts).
// При изменении prisma/schema.prisma перегенерируйте константу тем же скриптом.
// ALTER существующих таблиц бутстрап НЕ делает — обновление схем идёт через db:push.
//
// Канарейка целостности: после DDL (и для уже существующей БД) проверяются
// таблицы/колонки, исторически забывавшиеся при рассинхроне константы со схемой
// (MessageEvent, SegmentMember, Segment.mode, AppSettings.hooksEnabled). Отсутствие
// хоть одной — громкая ошибка бутстрапа (видна в /api/health как db: fail), а не
// тихие 500 по всем разделам UI.
import { db } from '@/lib/db';
import { hashPassword } from '@/lib/security/password';

/**
 * DDL-зеркало prisma/schema.prisma: одним массивом операторов (CREATE … IF NOT EXISTS)
 * создаёт пустую SQLite-схему при первом старте — там, где нет prisma CLI (контейнер,
 * standalone-дистрибутив; контекст — см. шапку файла). Генератор — scripts/gen-bootstrap-ddl.ts:
 * при изменении prisma/schema.prisma перегенерируйте константу им, руками НЕ править —
 * ручные правки рассинхронят зеркало со схемой и всплывут канарейкой ниже (или тихими 500).
 */
const SCHEMA_DDL: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS \"User\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"email\" TEXT NOT NULL,\n    \"name\" TEXT,\n    \"passwordHash\" TEXT NOT NULL,\n    \"role\" TEXT NOT NULL DEFAULT 'VIEWER',\n    \"isActive\" BOOLEAN NOT NULL DEFAULT true,\n    \"failedLoginCount\" INTEGER NOT NULL DEFAULT 0,\n    \"lockedUntil\" DATETIME,\n    \"mustChangePassword\" BOOLEAN NOT NULL DEFAULT false,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS \"Session\" (\n    \"idHash\" TEXT NOT NULL PRIMARY KEY,\n    \"userId\" TEXT NOT NULL,\n    \"expiresAt\" DATETIME NOT NULL,\n    \"ip\" TEXT,\n    \"userAgent\" TEXT,\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL,\n    CONSTRAINT \"Session_userId_fkey\" FOREIGN KEY (\"userId\") REFERENCES \"User\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS \"PasswordHistory\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"userId\" TEXT NOT NULL,\n    \"passwordHash\" TEXT NOT NULL,\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    CONSTRAINT \"PasswordHistory_userId_fkey\" FOREIGN KEY (\"userId\") REFERENCES \"User\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS \"AuditLog\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"userId\" TEXT,\n    \"userEmail\" TEXT,\n    \"action\" TEXT NOT NULL,\n    \"entityType\" TEXT NOT NULL,\n    \"entityId\" TEXT,\n    \"details\" TEXT,\n    \"ip\" TEXT,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\n);",
  "CREATE TABLE IF NOT EXISTS \"ApiKey\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"name\" TEXT NOT NULL,\n    \"keyHash\" TEXT NOT NULL,\n    \"prefix\" TEXT NOT NULL,\n    \"ipAllowlist\" TEXT,\n    \"rateLimitPerMin\" INTEGER,\n    \"isActive\" BOOLEAN NOT NULL DEFAULT true,\n    \"lastUsedAt\" DATETIME,\n    \"revokedAt\" DATETIME,\n    \"createdById\" TEXT,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS \"RateLimitEntry\" (\n    \"key\" TEXT NOT NULL PRIMARY KEY,\n    \"windowStart\" DATETIME NOT NULL,\n    \"count\" INTEGER NOT NULL DEFAULT 0\n);",
  "CREATE TABLE IF NOT EXISTS \"Client\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"externalId\" TEXT NOT NULL,\n    \"phone\" TEXT NOT NULL,\n    \"timezone\" TEXT NOT NULL DEFAULT 'Asia/Novosibirsk',\n    \"data\" TEXT NOT NULL DEFAULT '{}',\n    \"smsConsentStatus\" TEXT NOT NULL DEFAULT 'NONE',\n    \"smsConsentSource\" TEXT,\n    \"smsConsentAt\" DATETIME,\n    \"unsubscribedAt\" DATETIME,\n    \"firstName\" TEXT,\n    \"lastName\" TEXT,\n    \"middleName\" TEXT,\n    \"email\" TEXT,\n    \"applicationId\" INTEGER,\n    \"applicationStatus\" INTEGER,\n    \"applicationPrevStatus\" INTEGER,\n    \"agreementId\" INTEGER,\n    \"agreementStatus\" INTEGER,\n    \"agreementPrevStatus\" INTEGER,\n    \"loanAmount\" REAL,\n    \"loanPeriod\" INTEGER,\n    \"loanClosedAt\" DATETIME,\n    \"notificationActive\" BOOLEAN NOT NULL DEFAULT true,\n    \"offerDateStart\" DATETIME,\n    \"offerDateExpired\" DATETIME,\n    \"offerApproveMoney\" REAL,\n    \"offerApproveDays\" INTEGER,\n    \"offerAvailable\" BOOLEAN,\n    \"birthday\" DATETIME,\n    \"lastProductType\" TEXT,\n    \"agreementsLastYear\" INTEGER,\n    \"agreementsLifetime\" INTEGER,\n    \"banDays\" INTEGER,\n    \"profileUpdatedAt\" DATETIME,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS \"BirthdayCalendar\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"monthDay\" INTEGER NOT NULL,\n    \"clientId\" TEXT NOT NULL,\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    CONSTRAINT \"BirthdayCalendar_clientId_fkey\" FOREIGN KEY (\"clientId\") REFERENCES \"Client\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS \"SmsTemplate\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"name\" TEXT NOT NULL,\n    \"body\" TEXT NOT NULL,\n    \"isMarketing\" BOOLEAN NOT NULL DEFAULT false,\n    \"version\" INTEGER NOT NULL DEFAULT 1,\n    \"isActive\" BOOLEAN NOT NULL DEFAULT true,\n    \"description\" TEXT,\n    \"senderName\" TEXT,\n    \"maxSegments\" INTEGER NOT NULL DEFAULT 0,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS \"Funnel\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"name\" TEXT NOT NULL,\n    \"triggerEvent\" TEXT NOT NULL,\n    \"isActive\" BOOLEAN NOT NULL DEFAULT false,\n    \"version\" INTEGER NOT NULL DEFAULT 1,\n    \"definition\" TEXT NOT NULL,\n    \"entryMode\" TEXT NOT NULL DEFAULT 'SKIP_ACTIVE',\n    \"description\" TEXT,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS \"Segment\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"name\" TEXT NOT NULL,\n    \"description\" TEXT,\n    \"conditions\" TEXT NOT NULL,\n    \"mode\" TEXT NOT NULL DEFAULT 'dynamic',\n    \"frozenCount\" INTEGER,\n    \"frozenAt\" DATETIME,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS \"SegmentMember\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"segmentId\" TEXT NOT NULL,\n    \"clientId\" TEXT NOT NULL,\n    \"frozenAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    CONSTRAINT \"SegmentMember_segmentId_fkey\" FOREIGN KEY (\"segmentId\") REFERENCES \"Segment\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE,\n    CONSTRAINT \"SegmentMember_clientId_fkey\" FOREIGN KEY (\"clientId\") REFERENCES \"Client\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS \"Broadcast\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"name\" TEXT NOT NULL,\n    \"description\" TEXT,\n    \"segmentId\" TEXT NOT NULL,\n    \"templateId\" TEXT NOT NULL,\n    \"baseUrl\" TEXT,\n    \"kind\" TEXT NOT NULL DEFAULT 'ONCE',\n    \"runAt\" DATETIME,\n    \"weekday\" INTEGER,\n    \"hour\" INTEGER,\n    \"minute\" INTEGER NOT NULL DEFAULT 0,\n    \"minDaysBetween\" INTEGER NOT NULL DEFAULT 7,\n    \"maxRecipients\" INTEGER NOT NULL DEFAULT 1000,\n    \"status\" TEXT NOT NULL DEFAULT 'ACTIVE',\n    \"nextRunAt\" DATETIME,\n    \"lastRunAt\" DATETIME,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS \"BroadcastRun\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"broadcastId\" TEXT NOT NULL,\n    \"status\" TEXT NOT NULL DEFAULT 'RUNNING',\n    \"planned\" INTEGER NOT NULL DEFAULT 0,\n    \"recipients\" INTEGER NOT NULL DEFAULT 0,\n    \"skippedGuard\" INTEGER NOT NULL DEFAULT 0,\n    \"cappedBy\" INTEGER NOT NULL DEFAULT 0,\n    \"error\" TEXT,\n    \"startedAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"finishedAt\" DATETIME,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL,\n    CONSTRAINT \"BroadcastRun_broadcastId_fkey\" FOREIGN KEY (\"broadcastId\") REFERENCES \"Broadcast\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS \"EventsInbox\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"event\" TEXT NOT NULL,\n    \"externalId\" TEXT NOT NULL,\n    \"payload\" TEXT,\n    \"unknownFields\" TEXT,\n    \"idempotencyKey\" TEXT NOT NULL,\n    \"status\" TEXT NOT NULL DEFAULT 'NEW',\n    \"result\" TEXT,\n    \"error\" TEXT,\n    \"apiKeyId\" TEXT,\n    \"source\" TEXT NOT NULL DEFAULT 'API',\n    \"ip\" TEXT,\n    \"baseUrl\" TEXT,\n    \"skipTriggers\" BOOLEAN NOT NULL DEFAULT false,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS \"UnknownFieldObservation\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"fieldName\" TEXT NOT NULL,\n    \"count\" INTEGER NOT NULL DEFAULT 0,\n    \"firstSeenAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"lastSeenAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"lastEventId\" TEXT,\n    \"lastEventName\" TEXT,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS \"CustomField\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"key\" TEXT NOT NULL,\n    \"label\" TEXT NOT NULL,\n    \"type\" TEXT NOT NULL DEFAULT 'text',\n    \"description\" TEXT,\n    \"isActive\" BOOLEAN NOT NULL DEFAULT true,\n    \"createdById\" TEXT,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS \"ClientFieldValue\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"fieldId\" TEXT NOT NULL,\n    \"clientId\" TEXT NOT NULL,\n    \"valueStr\" TEXT,\n    \"valueNum\" REAL,\n    \"valueDate\" DATETIME,\n    \"valueBool\" BOOLEAN,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL,\n    CONSTRAINT \"ClientFieldValue_fieldId_fkey\" FOREIGN KEY (\"fieldId\") REFERENCES \"CustomField\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE,\n    CONSTRAINT \"ClientFieldValue_clientId_fkey\" FOREIGN KEY (\"clientId\") REFERENCES \"Client\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS \"WorkflowInstance\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"funnelId\" TEXT NOT NULL,\n    \"funnelVersion\" INTEGER NOT NULL,\n    \"funnelName\" TEXT NOT NULL,\n    \"clientId\" TEXT NOT NULL,\n    \"currentNodeId\" TEXT,\n    \"status\" TEXT NOT NULL DEFAULT 'RUNNING',\n    \"context\" TEXT NOT NULL DEFAULT '{}',\n    \"error\" TEXT,\n    \"eventId\" TEXT,\n    \"idempotencyKey\" TEXT,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL,\n    CONSTRAINT \"WorkflowInstance_funnelId_fkey\" FOREIGN KEY (\"funnelId\") REFERENCES \"Funnel\" (\"id\") ON DELETE RESTRICT ON UPDATE CASCADE,\n    CONSTRAINT \"WorkflowInstance_clientId_fkey\" FOREIGN KEY (\"clientId\") REFERENCES \"Client\" (\"id\") ON DELETE RESTRICT ON UPDATE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS \"ScheduledJob\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"instanceId\" TEXT NOT NULL,\n    \"nodeId\" TEXT NOT NULL,\n    \"reason\" TEXT NOT NULL DEFAULT 'NODE_DELAY',\n    \"runAt\" DATETIME NOT NULL,\n    \"status\" TEXT NOT NULL DEFAULT 'PENDING',\n    \"attempts\" INTEGER NOT NULL DEFAULT 0,\n    \"lockedBy\" TEXT,\n    \"lockedUntil\" DATETIME,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL,\n    CONSTRAINT \"ScheduledJob_instanceId_fkey\" FOREIGN KEY (\"instanceId\") REFERENCES \"WorkflowInstance\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS \"InstanceEvent\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"instanceId\" TEXT NOT NULL,\n    \"type\" TEXT NOT NULL,\n    \"nodeId\" TEXT,\n    \"nodeType\" TEXT,\n    \"message\" TEXT,\n    \"payload\" TEXT,\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    CONSTRAINT \"InstanceEvent_instanceId_fkey\" FOREIGN KEY (\"instanceId\") REFERENCES \"WorkflowInstance\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS \"ProfileChangeLog\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"clientId\" TEXT NOT NULL,\n    \"field\" TEXT NOT NULL,\n    \"oldValue\" TEXT,\n    \"newValue\" TEXT,\n    \"source\" TEXT NOT NULL,\n    \"sourceDetails\" TEXT,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    CONSTRAINT \"ProfileChangeLog_clientId_fkey\" FOREIGN KEY (\"clientId\") REFERENCES \"Client\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS \"MassUpdateJob\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"name\" TEXT NOT NULL,\n    \"segmentId\" TEXT NOT NULL,\n    \"segmentName\" TEXT NOT NULL,\n    \"updates\" TEXT NOT NULL,\n    \"maxAffected\" INTEGER NOT NULL DEFAULT 10000,\n    \"status\" TEXT NOT NULL DEFAULT 'PENDING',\n    \"planned\" INTEGER NOT NULL DEFAULT 0,\n    \"processed\" INTEGER NOT NULL DEFAULT 0,\n    \"affected\" INTEGER NOT NULL DEFAULT 0,\n    \"error\" TEXT,\n    \"createdById\" TEXT,\n    \"createdByEmail\" TEXT,\n    \"startedAt\" DATETIME,\n    \"finishedAt\" DATETIME,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS \"SmsMessage\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"instanceId\" TEXT,\n    \"clientId\" TEXT,\n    \"phone\" TEXT NOT NULL,\n    \"body\" TEXT NOT NULL,\n    \"segments\" INTEGER NOT NULL DEFAULT 1,\n    \"provider\" TEXT NOT NULL,\n    \"providerMessageId\" TEXT,\n    \"providerVersion\" INTEGER,\n    \"priceKopecks\" INTEGER,\n    \"operatorCode\" TEXT,\n    \"templateId\" TEXT,\n    \"templateName\" TEXT,\n    \"status\" TEXT NOT NULL DEFAULT 'QUEUED',\n    \"rejectReason\" TEXT,\n    \"error\" TEXT,\n    \"varsSnapshot\" TEXT,\n    \"sentAt\" DATETIME,\n    \"deliveredAt\" DATETIME,\n    \"attempts\" INTEGER NOT NULL DEFAULT 0,\n    \"broadcastId\" TEXT,\n    \"broadcastName\" TEXT,\n    \"runId\" TEXT,\n    \"scheduledFor\" DATETIME,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL,\n    CONSTRAINT \"SmsMessage_instanceId_fkey\" FOREIGN KEY (\"instanceId\") REFERENCES \"WorkflowInstance\" (\"id\") ON DELETE SET NULL ON UPDATE CASCADE,\n    CONSTRAINT \"SmsMessage_clientId_fkey\" FOREIGN KEY (\"clientId\") REFERENCES \"Client\" (\"id\") ON DELETE SET NULL ON UPDATE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS \"UnsubscribeList\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"phone\" TEXT NOT NULL,\n    \"source\" TEXT NOT NULL DEFAULT 'LINK',\n    \"clientId\" TEXT,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\n);",
  "CREATE TABLE IF NOT EXISTS \"MessageEvent\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"source\" TEXT NOT NULL,\n    \"eventType\" TEXT NOT NULL,\n    \"eventDate\" DATETIME NOT NULL,\n    \"receivedAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"phone\" TEXT,\n    \"provider\" TEXT,\n    \"smsMessageId\" TEXT,\n    \"clientId\" TEXT,\n    \"externalIds\" TEXT,\n    \"payload\" TEXT NOT NULL,\n    \"dedupKey\" TEXT NOT NULL,\n    \"status\" TEXT NOT NULL DEFAULT 'PROCESSED',\n    \"result\" TEXT,\n    \"forwardedAt\" DATETIME,\n    \"forwardAttempts\" INTEGER NOT NULL DEFAULT 0,\n    \"forwardError\" TEXT,\n    \"nextForwardAt\" DATETIME,\n    \"forwardSkip\" BOOLEAN NOT NULL DEFAULT false,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS \"ShortLink\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"code\" TEXT NOT NULL,\n    \"kind\" TEXT NOT NULL DEFAULT 'UNSUBSCRIBE',\n    \"token\" TEXT,\n    \"name\" TEXT,\n    \"targetUrl\" TEXT,\n    \"clientId\" TEXT,\n    \"visits\" INTEGER NOT NULL DEFAULT 0,\n    \"lastVisitAt\" DATETIME,\n    \"expiresAt\" DATETIME,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS \"ShortLinkVisit\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY,\n    \"linkId\" TEXT NOT NULL,\n    \"kind\" TEXT NOT NULL,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    CONSTRAINT \"ShortLinkVisit_linkId_fkey\" FOREIGN KEY (\"linkId\") REFERENCES \"ShortLink\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS \"AppSettings\" (\n    \"id\" TEXT NOT NULL PRIMARY KEY DEFAULT 'app',\n    \"advertiserName\" TEXT NOT NULL DEFAULT 'ДемоКомпания',\n    \"quietHoursStart\" INTEGER NOT NULL DEFAULT 21,\n    \"quietHoursEnd\" INTEGER NOT NULL DEFAULT 9,\n    \"dailyClientLimit\" INTEGER NOT NULL DEFAULT 3,\n    \"systemDailyLimit\" INTEGER NOT NULL DEFAULT 5000,\n    \"provider\" TEXT NOT NULL DEFAULT 'sandbox',\n    \"unsubscribeBaseUrl\" TEXT NOT NULL DEFAULT '',\n    \"defaultTimezone\" TEXT NOT NULL DEFAULT 'Asia/Novosibirsk',\n    \"defaultSenderName\" TEXT NOT NULL DEFAULT 'DemoBrand',\n    \"smstechToken\" TEXT NOT NULL DEFAULT '',\n    \"t2Login\" TEXT NOT NULL DEFAULT '',\n    \"t2Password\" TEXT NOT NULL DEFAULT '',\n    \"mtsLogin\" TEXT NOT NULL DEFAULT '',\n    \"mtsPassword\" TEXT NOT NULL DEFAULT '',\n    \"useShortLinks\" BOOLEAN NOT NULL DEFAULT true,\n    \"marketingDisclaimer\" TEXT NOT NULL DEFAULT '',\n    \"inboxRetentionDays\" INTEGER NOT NULL DEFAULT 30,\n    \"messageEventRetentionDays\" INTEGER NOT NULL DEFAULT 0,\n    \"hooksEnabled\" BOOLEAN NOT NULL DEFAULT true,\n    \"hooksToken\" TEXT NOT NULL DEFAULT '',\n    \"forwarderEnabled\" BOOLEAN NOT NULL DEFAULT false,\n    \"forwarderUrl\" TEXT NOT NULL DEFAULT '',\n    \"forwarderToken\" TEXT NOT NULL DEFAULT '',\n    \"forwarderBatchSize\" INTEGER NOT NULL DEFAULT 500,\n    \"tenantId\" TEXT NOT NULL DEFAULT 'trigger',\n    \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"updatedAt\" DATETIME NOT NULL\n);",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"User_email_key\" ON \"User\"(\"email\");",
  "CREATE INDEX IF NOT EXISTS \"Session_userId_idx\" ON \"Session\"(\"userId\");",
  "CREATE INDEX IF NOT EXISTS \"PasswordHistory_userId_createdAt_idx\" ON \"PasswordHistory\"(\"userId\", \"createdAt\");",
  "CREATE INDEX IF NOT EXISTS \"AuditLog_entityType_entityId_idx\" ON \"AuditLog\"(\"entityType\", \"entityId\");",
  "CREATE INDEX IF NOT EXISTS \"AuditLog_createdAt_idx\" ON \"AuditLog\"(\"createdAt\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"ApiKey_keyHash_key\" ON \"ApiKey\"(\"keyHash\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"Client_externalId_key\" ON \"Client\"(\"externalId\");",
  "CREATE INDEX IF NOT EXISTS \"Client_createdAt_idx\" ON \"Client\"(\"createdAt\");",
  "CREATE INDEX IF NOT EXISTS \"Client_phone_idx\" ON \"Client\"(\"phone\");",
  "CREATE INDEX IF NOT EXISTS \"Client_smsConsentStatus_idx\" ON \"Client\"(\"smsConsentStatus\");",
  "CREATE INDEX IF NOT EXISTS \"Client_agreementStatus_idx\" ON \"Client\"(\"agreementStatus\");",
  "CREATE INDEX IF NOT EXISTS \"Client_applicationStatus_idx\" ON \"Client\"(\"applicationStatus\");",
  "CREATE INDEX IF NOT EXISTS \"Client_lastProductType_idx\" ON \"Client\"(\"lastProductType\");",
  "CREATE INDEX IF NOT EXISTS \"Client_notificationActive_idx\" ON \"Client\"(\"notificationActive\");",
  "CREATE INDEX IF NOT EXISTS \"Client_birthday_idx\" ON \"Client\"(\"birthday\");",
  "CREATE INDEX IF NOT EXISTS \"Client_offerDateExpired_idx\" ON \"Client\"(\"offerDateExpired\");",
  "CREATE INDEX IF NOT EXISTS \"Client_loanClosedAt_idx\" ON \"Client\"(\"loanClosedAt\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"BirthdayCalendar_clientId_key\" ON \"BirthdayCalendar\"(\"clientId\");",
  "CREATE INDEX IF NOT EXISTS \"BirthdayCalendar_monthDay_idx\" ON \"BirthdayCalendar\"(\"monthDay\");",
  "CREATE INDEX IF NOT EXISTS \"Funnel_triggerEvent_isActive_idx\" ON \"Funnel\"(\"triggerEvent\", \"isActive\");",
  "CREATE INDEX IF NOT EXISTS \"Segment_name_idx\" ON \"Segment\"(\"name\");",
  "CREATE INDEX IF NOT EXISTS \"SegmentMember_segmentId_idx\" ON \"SegmentMember\"(\"segmentId\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"SegmentMember_segmentId_clientId_key\" ON \"SegmentMember\"(\"segmentId\", \"clientId\");",
  "CREATE INDEX IF NOT EXISTS \"Broadcast_status_nextRunAt_idx\" ON \"Broadcast\"(\"status\", \"nextRunAt\");",
  "CREATE INDEX IF NOT EXISTS \"Broadcast_segmentId_idx\" ON \"Broadcast\"(\"segmentId\");",
  "CREATE INDEX IF NOT EXISTS \"BroadcastRun_broadcastId_startedAt_idx\" ON \"BroadcastRun\"(\"broadcastId\", \"startedAt\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"EventsInbox_idempotencyKey_key\" ON \"EventsInbox\"(\"idempotencyKey\");",
  "CREATE INDEX IF NOT EXISTS \"EventsInbox_status_idx\" ON \"EventsInbox\"(\"status\");",
  "CREATE INDEX IF NOT EXISTS \"EventsInbox_event_idx\" ON \"EventsInbox\"(\"event\");",
  "CREATE INDEX IF NOT EXISTS \"EventsInbox_externalId_idx\" ON \"EventsInbox\"(\"externalId\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"UnknownFieldObservation_fieldName_key\" ON \"UnknownFieldObservation\"(\"fieldName\");",
  "CREATE INDEX IF NOT EXISTS \"UnknownFieldObservation_lastSeenAt_idx\" ON \"UnknownFieldObservation\"(\"lastSeenAt\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"CustomField_key_key\" ON \"CustomField\"(\"key\");",
  "CREATE INDEX IF NOT EXISTS \"CustomField_isActive_idx\" ON \"CustomField\"(\"isActive\");",
  "CREATE INDEX IF NOT EXISTS \"ClientFieldValue_clientId_idx\" ON \"ClientFieldValue\"(\"clientId\");",
  "CREATE INDEX IF NOT EXISTS \"ClientFieldValue_fieldId_valueNum_idx\" ON \"ClientFieldValue\"(\"fieldId\", \"valueNum\");",
  "CREATE INDEX IF NOT EXISTS \"ClientFieldValue_fieldId_valueStr_idx\" ON \"ClientFieldValue\"(\"fieldId\", \"valueStr\");",
  "CREATE INDEX IF NOT EXISTS \"ClientFieldValue_fieldId_valueDate_idx\" ON \"ClientFieldValue\"(\"fieldId\", \"valueDate\");",
  "CREATE INDEX IF NOT EXISTS \"ClientFieldValue_fieldId_valueBool_idx\" ON \"ClientFieldValue\"(\"fieldId\", \"valueBool\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"ClientFieldValue_fieldId_clientId_key\" ON \"ClientFieldValue\"(\"fieldId\", \"clientId\");",
  "CREATE INDEX IF NOT EXISTS \"WorkflowInstance_status_idx\" ON \"WorkflowInstance\"(\"status\");",
  "CREATE INDEX IF NOT EXISTS \"WorkflowInstance_clientId_idx\" ON \"WorkflowInstance\"(\"clientId\");",
  "CREATE INDEX IF NOT EXISTS \"WorkflowInstance_funnelId_idx\" ON \"WorkflowInstance\"(\"funnelId\");",
  "CREATE INDEX IF NOT EXISTS \"WorkflowInstance_createdAt_idx\" ON \"WorkflowInstance\"(\"createdAt\");",
  "CREATE INDEX IF NOT EXISTS \"ScheduledJob_runAt_status_idx\" ON \"ScheduledJob\"(\"runAt\", \"status\");",
  "CREATE INDEX IF NOT EXISTS \"ScheduledJob_instanceId_idx\" ON \"ScheduledJob\"(\"instanceId\");",
  "CREATE INDEX IF NOT EXISTS \"ScheduledJob_instanceId_reason_idx\" ON \"ScheduledJob\"(\"instanceId\", \"reason\");",
  "CREATE INDEX IF NOT EXISTS \"InstanceEvent_instanceId_createdAt_idx\" ON \"InstanceEvent\"(\"instanceId\", \"createdAt\");",
  "CREATE INDEX IF NOT EXISTS \"ProfileChangeLog_clientId_createdAt_idx\" ON \"ProfileChangeLog\"(\"clientId\", \"createdAt\");",
  "CREATE INDEX IF NOT EXISTS \"ProfileChangeLog_createdAt_idx\" ON \"ProfileChangeLog\"(\"createdAt\");",
  "CREATE INDEX IF NOT EXISTS \"MassUpdateJob_status_idx\" ON \"MassUpdateJob\"(\"status\");",
  "CREATE INDEX IF NOT EXISTS \"MassUpdateJob_createdAt_idx\" ON \"MassUpdateJob\"(\"createdAt\");",
  "CREATE INDEX IF NOT EXISTS \"SmsMessage_createdAt_status_templateName_idx\" ON \"SmsMessage\"(\"createdAt\", \"status\", \"templateName\");",
  "CREATE INDEX IF NOT EXISTS \"SmsMessage_clientId_createdAt_idx\" ON \"SmsMessage\"(\"clientId\", \"createdAt\");",
  "CREATE INDEX IF NOT EXISTS \"SmsMessage_status_idx\" ON \"SmsMessage\"(\"status\");",
  "CREATE INDEX IF NOT EXISTS \"SmsMessage_phone_idx\" ON \"SmsMessage\"(\"phone\");",
  "CREATE INDEX IF NOT EXISTS \"SmsMessage_providerMessageId_idx\" ON \"SmsMessage\"(\"providerMessageId\");",
  "CREATE INDEX IF NOT EXISTS \"SmsMessage_broadcastId_idx\" ON \"SmsMessage\"(\"broadcastId\");",
  "CREATE INDEX IF NOT EXISTS \"SmsMessage_runId_idx\" ON \"SmsMessage\"(\"runId\");",
  "CREATE INDEX IF NOT EXISTS \"SmsMessage_status_scheduledFor_idx\" ON \"SmsMessage\"(\"status\", \"scheduledFor\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"UnsubscribeList_phone_key\" ON \"UnsubscribeList\"(\"phone\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"MessageEvent_dedupKey_key\" ON \"MessageEvent\"(\"dedupKey\");",
  "CREATE INDEX IF NOT EXISTS \"MessageEvent_receivedAt_idx\" ON \"MessageEvent\"(\"receivedAt\");",
  "CREATE INDEX IF NOT EXISTS \"MessageEvent_eventType_eventDate_idx\" ON \"MessageEvent\"(\"eventType\", \"eventDate\");",
  "CREATE INDEX IF NOT EXISTS \"MessageEvent_phone_idx\" ON \"MessageEvent\"(\"phone\");",
  "CREATE INDEX IF NOT EXISTS \"MessageEvent_smsMessageId_idx\" ON \"MessageEvent\"(\"smsMessageId\");",
  "CREATE INDEX IF NOT EXISTS \"MessageEvent_clientId_idx\" ON \"MessageEvent\"(\"clientId\");",
  "CREATE INDEX IF NOT EXISTS \"MessageEvent_forwardedAt_nextForwardAt_idx\" ON \"MessageEvent\"(\"forwardedAt\", \"nextForwardAt\");",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"ShortLink_code_key\" ON \"ShortLink\"(\"code\");",
  "CREATE INDEX IF NOT EXISTS \"ShortLink_expiresAt_idx\" ON \"ShortLink\"(\"expiresAt\");",
  "CREATE INDEX IF NOT EXISTS \"ShortLink_clientId_idx\" ON \"ShortLink\"(\"clientId\");",
  "CREATE INDEX IF NOT EXISTS \"ShortLink_kind_idx\" ON \"ShortLink\"(\"kind\");",
  "CREATE INDEX IF NOT EXISTS \"ShortLinkVisit_linkId_createdAt_idx\" ON \"ShortLinkVisit\"(\"linkId\", \"createdAt\");",
  "CREATE INDEX IF NOT EXISTS \"ShortLinkVisit_createdAt_kind_idx\" ON \"ShortLinkVisit\"(\"createdAt\", \"kind\");"
]/** Демо-пароль бутстрапа (только когда ADMIN_PASSWORD не задан окружением).
 *  Экспортируется для auth.skipPasswordChange: в production-сборке откладывать
 *  обязательную смену при всё ещё дефолтном пароле запрещено (иначе mustChange-
 *  Password не защищает вовсе: код и пароль публикуются вместе с дистрибутивом). */
export const DEFAULT_ADMIN_EMAIL = 'admin@trigger.local';
export const DEFAULT_ADMIN_PASSWORD = 'Admin!Trigger2026Demo';

let bootstrapPromise: Promise<void> | null = null;

/**
 * Канарейка целостности схемы: пары таблица→колонка, которые терялись при
 * забытой регенерации SCHEMA_DDL (см. gen-bootstrap-ddl.ts). Проверка дешёвая
 * (PRAGMA table_info), выполняется и для свежей, и для существующей БД:
 * пропуск = схема от старой версии кода, нужен `bunx prisma db push`
 * (deploy/update.sh делает это сам) либо регенерация константы.
 */
const SCHEMA_CANARY: readonly [string, string][] = [
  ['MessageEvent', 'dedupKey'],
  ['SegmentMember', 'segmentId'],
  ['Segment', 'mode'],
  ['AppSettings', 'hooksEnabled'],
  ['AppSettings', 'mtsLogin'], // интеграция МТС OmniChannel (v1.14): креды Basic Auth
  ['Client', 'loanClosedAt'], // расширение карточки окт. 2026: loan_closed_date
  ['EventsInbox', 'unknownFields'], // «радар» неизвестных полей client_card (v0.5.0)
  ['UnknownFieldObservation', 'fieldName'], // агрегат наблюдений радара (v0.5.0)
  ['CustomField', 'key'], // кастомные поля профилей Lite (v0.6.0)
  ['ClientFieldValue', 'fieldId'], // значения кастомных полей (EAV-lite, v0.6.0)
  ['ProfileChangeLog', 'source'], // история изменений профиля (P5, v0.7.0)
  ['MassUpdateJob', 'updates'], // массовое обновление по сегменту (P4, v0.7.0)
  ['SmsMessage', 'varsSnapshot'], // снимок переменных сообщения (P6, v0.7.0)
  ['PasswordHistory', 'passwordHash'], // история паролей: анти-повтор (v0.8.6)
  ['ApiKey', 'rateLimitPerMin'], // пер-ключевой лимит приёма событий (v0.9.0)
  ['EventsInbox', 'skipTriggers'], // батч-импорт «только карточка, без воронок» (v0.9.0)
  ['MessageEvent', 'forwardedAt'], // очередь обратного потока событий (v0.9.0)
  ['MessageEvent', 'forwardSkip'], // исключение накопленного до включения (v0.9.0)
  ['AppSettings', 'forwarderEnabled'], // конфигурация форвардера (v0.9.0)
  ['BirthdayCalendar', 'monthDay'], // календарь ДР: SQL-путь сегментов «ДР» (Task 63)
  ['AppSettings', 'messageEventRetentionDays'], // ретеншн журнала MessageEvent (Task 63)
];

async function verifySchemaCanary(): Promise<void> {
  for (const [table, column] of SCHEMA_CANARY) {
    const rows = await db.$queryRawUnsafe<{ name: string }[]>(
      `PRAGMA table_info("${table}")`,
    );
    if (!rows.some((r) => r.name === column)) {
      throw new Error(
        `схема неполна: нет ${table}.${column}. ` +
          'Свежая установка — перегенерируйте SCHEMA_DDL: bun scripts/gen-bootstrap-ddl.ts. ' +
          'Существующая БД — примените схему: bunx prisma db push.',
      );
    }
  }
}

/**
 * Идемпотентный бутстрап (результат кэшируется на процесс):
 *  1) если таблицы есть — ничего не делает (один SELECT);
 *  2) если нет — выполняет DDL (CREATE TABLE/INDEX IF NOT EXISTS);
 *  3) если пользователей 0 — создаёт администратора из env либо дефолтного
 *     (mustChangePassword=true — панель потребует смену пароля).
 * Ошибки НЕ роняют сервер: вызывающие стороны (instrumentation, /api/health)
 * перехватывают их сами.
 */
export function ensureDatabaseBootstrap(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = runBootstrap().catch((err: unknown) => {
      bootstrapPromise = null; // разрешаем повторную попытку следующим вызовом
      throw err;
    });
  }
  return bootstrapPromise;
}

async function tablesReady(): Promise<boolean> {
  try {
    await db.user.count();
    return true;
  } catch {
    return false;
  }
}

async function runBootstrap(): Promise<void> {
  if (await tablesReady()) {
    await verifySchemaCanary();
    await ensureAdmin();
    await ensureCoreCustomFields();
    return;
  }
  console.log('[db-bootstrap] таблицы не найдены — создаю схему (CREATE TABLE IF NOT EXISTS)');
  for (const stmt of SCHEMA_DDL) {
    try {
      await db.$executeRawUnsafe(stmt);
    } catch (err: unknown) {
      // Гонка параллельных процессов: уже создано — не фатально.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(msg)) throw err;
    }
  }
  if (!(await tablesReady())) {
    throw new Error('схема не создалась (таблицы User по-прежнему нет)');
  }
  await verifySchemaCanary();
  console.log('[db-bootstrap] схема создана (канарейка целостности пройдена)');
  await ensureAdmin();
  await ensureCoreCustomFields();
}

/** Регистрация «полей доработок системы данных» ч.1–4 как кастомных полей (G4):
 *  свежее развёртывание получает полный реестр интеграции из коробки.
 *  Идемпотентно (существующие ключи не трогаются — чужие настройки/деактивации
 *  неприкосновенны); сбой не роняет бутстрап (реестр можно дозарегистрировать
 *  вручную: bun scripts/register-core-fields.ts). */
async function ensureCoreCustomFields(): Promise<void> {
  try {
    const { CORE_CF_SEED } = await import('@/lib/registry/core-cf-seed');
    let created = 0;
    for (const seed of CORE_CF_SEED) {
      const existing = await db.customField.findUnique({ where: { key: seed.key }, select: { id: true } });
      if (existing) continue;
      await db.customField.create({
        data: {
          key: seed.key,
          label: seed.label,
          type: seed.type,
          description: seed.description,
          isActive: true,
        },
      });
      created += 1;
    }
    if (created > 0) {
      console.log(`[db-bootstrap] зарегистрировано полей доработок (ч.1–4): ${created}`);
    }
  } catch (e) {
    console.warn('[db-bootstrap] регистрация полей доработок пропущена:', e instanceof Error ? e.message : String(e));
  }
}

async function ensureAdmin(): Promise<void> {
  const users = await db.user.count();
  if (users > 0) return;

  const envEmail = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const envPassword = process.env.ADMIN_PASSWORD ?? '';
  const fromEnv = envEmail.length > 3 && envPassword.length >= 8;
  const email = fromEnv ? envEmail : DEFAULT_ADMIN_EMAIL;
  const password = fromEnv ? envPassword : DEFAULT_ADMIN_PASSWORD;

  // Слабый env-пароль (не проходит политику v0.8.6) — создаём, но сразу
  // требуем смену: бутстрап не должен падать (иначе сервер не поднимется),
  // но и слабый пароль не должен жить без принудительной смены.
  let forceChange = !fromEnv;
  if (fromEnv) {
    const { validatePasswordPolicy } = await import('@/lib/security/password');
    const policyError = validatePasswordPolicy(password, { email, name: null });
    if (policyError) {
      forceChange = true;
      console.warn(
        `[db-bootstrap] ADMIN_PASSWORD не проходит политику (${policyError}) — создаю с принудительной сменой пароля`,
      );
    }
  }

  try {
    await db.user.create({
      data: {
        email,
        name: 'Администратор',
        passwordHash: await hashPassword(password),
        role: 'ADMIN',
        isActive: true,
        mustChangePassword: forceChange,
        tenantId: (process.env.TENANT_ID ?? 'trigger').trim() || 'trigger',
      },
    });
    console.log(
      `[db-bootstrap] создан администратор ${email}` +
        (fromEnv ? ' (из окружения)' : ' (пароль по умолчанию — панель потребует смену при первом входе)'),
    );
  } catch (err: unknown) {
    // Гонка параллельных процессов: кто-то уже создал админа.
    const code = (err as { code?: string })?.code;
    if (code !== 'P2002') throw err;
  }
}
