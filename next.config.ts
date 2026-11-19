import type { NextConfig } from "next";

// HTTP-заголовки безопасности (defence-in-depth для развёртывания на сервере
// компании). Подробности и рекомендации по усилению — docs/security.md.
//
// CSP включается только в production (NODE_ENV=production): dev-режим песочницы
// использует Turbopack HMR (websocket/eval), который строгая CSP ломает.
// FRAME_PROTECTION=1 (env) на этапе СБОРКИ добавляет frame-ancestors 'none' в
// CSP; рантайм-вариант для готового архива (X-Frame-Options: DENY без
// пересборки) — src/proxy.ts. По умолчанию выключено, чтобы не ломать
// предпросмотр платформы.
const isProd = process.env.NODE_ENV === "production";
const frameDeny = process.env.FRAME_PROTECTION === "1";

const securityHeaders: { key: string; value: string }[] = [
  // Запрет MIME-сниффинга (защита от upload/interpretation атак)
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Реферер только для своих origin — не светим URL с токенами отписки
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Минимальная поверхность браузерных API
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  // HSTS: полгода без includeSubDomains (безопасно для http-внутренних имён —
  // браузеры игнорируют заголовок на http; https-хост фиксируется)
  { key: "Strict-Transport-Security", value: "max-age=15552000" },
];

if (frameDeny) {
  securityHeaders.push({ key: "X-Frame-Options", value: "DENY" });
}

// CSP: всё только с себя; inline-стили/скрипты разрешены (Next.js инжектит
// бутстрап-скрипты без nonce); connect-src 'self' блокирует эксфильтрацию
// данных на внешние домены при XSS. frame-ancestors — только при FRAME_PROTECTION.
const cspValue = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  ...(frameDeny ? ["frame-ancestors 'none'"] : []),
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  // Оптимизатор картинок Next.js не задействован (нет next/image — иконка/лого
  // отдаются как есть). unoptimized=true выключает оптимизатор: standalone-трейс
  // НЕ тащит нативные бинари sharp (@img/sharp-* под все платформы) — иначе
  // свежий bun install (только текущая платформа) ломал сборку ENOENT на
  // copyfile linuxmusl-варианта, а архив распухал на ~10 МБ.
  images: {
    unoptimized: true,
  },
  // Тяжёлые tar.gz-дистрибутивы (до 56 МБ) не должны попадать в standalone-трейс:
  // опубликованный контейнер остаётся лёгким, а «Документация» без архивов
  // деградирует корректно (info → exists:false). Архивы — артефакт песочницы,
  // в git-контенте их нет, поэтому внешние сборки и так их не видят.
  outputFileTracingExcludes: {
    "/api/**": ["./download/**"],
    // sharp НЕ используется приложением (см. images.unoptimized выше), но
    // nft-трейс следует за require('sharp') из next/server/image-optimizer и
    // перечисляет ВСЕ платформенные @img-варианты; свежий bun install кладёт
    // только текущую платформу → копирование в standalone падало ENOENT на
    // linuxmusl-варианте. Исключаем весь sharp-кластер из трейса.
    "*": ["./node_modules/sharp/**", "./node_modules/@img/**"],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Выключает плавающий индикатор Next.js DevTools (значок «N» в левом нижнем
  // углу в dev-режиме). Это служебный оверлей фреймворка, а не часть UI
  // приложения; на production-сборке его и так нет, здесь убираем и из dev.
  devIndicators: false,
  async headers() {
    const commonHeaders = isProd
      ? [...securityHeaders, { key: "Content-Security-Policy", value: cspValue }]
      : securityHeaders;
    return [
      {
        // Все страницы и ассеты
        source: "/:path*",
        headers: commonHeaders,
      },
      {
        // API-ответы не кэшируются посредниками (авторизованные данные — перс. инфо)
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
