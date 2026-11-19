// Корневой layout: единственная оболочка всего приложения — шрифт, метаданные
// и глобальные провайдеры. Слой: серверный компонент Next.js (App Router),
// рендерит и единственную страницу src/app/page.tsx. Здесь подключены: Inter
// (с кириллицей), ThemeProvider (next-themes) и Toaster (sonner) — глобальный
// канал уведомлений для всех view (import { toast } from 'sonner').
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

// Inter — с кириллицей (Geist её не содержит)
const inter = Inter({
  subsets: ["latin", "cyrillic"],
  variable: "--font-geist-sans",
  display: "swap",
});

// Заголовок/описание вкладки браузера; robots noindex — внутренний инструмент
// компании, в поисковые индексы попадать не должен
export const metadata: Metadata = {
  title: "Trigger — панель триггерных SMS",
  description: "Внутренний инструмент компании: триггерные SMS-коммуникации по событиям ядра",
  robots: { index: false, follow: false },
};

/** Корневой layout: <html>/<body>, шрифт-переменная, тема, тосты.
 * suppressHydrationWarning — next-themes меняет класс на <html> до гидрации
 * (иначе React ругался бы на рассинхрон серверного/клиентского html). */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body
        className={`${inter.variable} font-sans antialiased bg-background text-foreground`}
      >
        {/* Тёмная тема — класс на <html>, первый визит по системной настройке,
            выбор пользователя сохраняется в localStorage (no-flash: тема ставится
            до первой отрисовки инлайн-скриптом next-themes) */}
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          {/* Глобальные уведомления sonner: richColors — успех/ошибка цветом,
              правый верхний угол */}
          <Toaster richColors position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
