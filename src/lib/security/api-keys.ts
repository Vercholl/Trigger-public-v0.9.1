// API-ключи приёма событий: генерация (evt_ + 48 hex), хранение sha256 + prefix,
// IP-allowlist: точное совпадение IPv4/IPv6 и CIDR-подсети для IPv4.
import { randomBytes } from 'crypto';
import type { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { sha256Hex } from '@/lib/security/session';
import { constantTimeEquals } from '@/lib/security/secrets';

export interface ApiKeyAuthResult {
  ok: boolean;
  apiKeyId: string | null;
  source: 'STATIC' | 'DB';
  /** Пер-ключевой лимит запросов/мин (ApiKey.rateLimitPerMin) — для ключей БД;
  *  null — лимит не задан (действует дефолт env). */
  rateLimitPerMin: number | null;
}

/** Ключ вида evt_<48 hex>. Показывается пользователю ровно один раз. */
export function generateApiKey(): string {
  return `evt_${randomBytes(24).toString('hex')}`;
}

export function apiKeyPrefix(key: string): string {
  return key.slice(0, 10);
}

function parseIPv4(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((p) => p > 255)) return null;
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function isValidIPv6(ip: string): boolean {
  // Приближённая проверка: только hex и ':', не более одного '::', 2..8 групп.
  if (!/^[0-9A-Fa-f:]+$/.test(ip)) return false;
  const doubleColonCount = (ip.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return false;
  const groups = ip.split('::').flatMap((part) => (part === '' ? [] : part.split(':')));
  if (groups.length < 1 || groups.length > 8) return false;
  return groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g));
}

function isValidIPv4Cidr(cidr: string): boolean {
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (!m) return false;
  if (parseIPv4(m[1]) === null) return false;
  const bits = Number(m[2]);
  return bits >= 0 && bits <= 32;
}

/**
 * Валидация allowlist: CSV из IPv4, IPv4-CIDR, IPv6.
 * Возвращает текст ошибки или null, если всё корректно.
 */
export function validateIpAllowlist(csv: string): string | null {
  const entries = csv
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  if (entries.length === 0) return null;
  for (const entry of entries) {
    const isIPv4 = parseIPv4(entry) !== null;
    const isCidr = isValidIPv4Cidr(entry);
    const isIPv6 = isValidIPv6(entry);
    if (!isIPv4 && !isCidr && !isIPv6) {
      return `Некорректный IP-адрес или подсеть: ${entry}`;
    }
  }
  return null;
}

function cidrMatch(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  const base = cidr.slice(0, slash);
  const bits = Number.parseInt(cidr.slice(slash + 1), 10);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipInt = parseIPv4(ip);
  const baseInt = parseIPv4(base);
  if (ipInt === null || baseInt === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** Разрешён ли IP: пустой allowlist разрешает всё; IPv4 — exact/CIDR, IPv6 — exact. */
export function ipMatchesAllowlist(ip: string, allowlist: string): boolean {
  const entries = allowlist
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  if (entries.length === 0) return true;
  for (const entry of entries) {
    if (entry.includes('/')) {
      if (cidrMatch(ip, entry)) return true;
    } else if (entry.toLowerCase() === ip.toLowerCase()) {
      return true;
    }
  }
  return false;
}

/**
 * Аутентификация события по заголовку X-Api-Key:
 * 1) совпадение со статическим env EVENTS_API_KEY (источник STATIC);
 * 2) sha256-совпадение в ApiKey (isActive, не отозван) + IP-allowlist (обновляет lastUsedAt).
 */
export async function authenticateApiKey(req: NextRequest, ip: string): Promise<ApiKeyAuthResult> {
  const key = req.headers.get('x-api-key');
  if (!key) return { ok: false, apiKeyId: null, source: 'STATIC', rateLimitPerMin: null };

  const staticKey = process.env.EVENTS_API_KEY;
  if (staticKey && staticKey.trim() !== '' && constantTimeEquals(key, staticKey.trim())) {
    return { ok: true, apiKeyId: null, source: 'STATIC', rateLimitPerMin: null };
  }

  const record = await db.apiKey.findUnique({ where: { keyHash: sha256Hex(key) } });
  if (!record || !record.isActive || record.revokedAt !== null) {
    return { ok: false, apiKeyId: null, source: 'DB', rateLimitPerMin: null };
  }
  if (record.ipAllowlist && record.ipAllowlist.trim() !== '' && !ipMatchesAllowlist(ip, record.ipAllowlist)) {
    return { ok: false, apiKeyId: null, source: 'DB', rateLimitPerMin: null };
  }
  await db.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } });
  return {
    ok: true,
    apiKeyId: record.id,
    source: 'DB',
    rateLimitPerMin: record.rateLimitPerMin ?? null,
  };
}
