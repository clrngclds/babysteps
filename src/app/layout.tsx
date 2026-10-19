import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { AppProvider } from '@/components/AppProvider';
import { Shell } from '@/components/Shell';

// Self-hosted, latin subset, variable fonts (SDD §4.4). No runtime requests to Google Fonts.
const fraunces = localFont({
  src: '../fonts/Fraunces-latin-var.woff2',
  weight: '500 700',
  style: 'normal',
  display: 'swap',
  variable: '--font-fraunces',
  fallback: ['Georgia', 'serif'],
});
const dmSans = localFont({
  src: '../fonts/DMSans-latin-var.woff2',
  weight: '400 700',
  style: 'normal',
  display: 'swap',
  variable: '--font-dmsans',
  fallback: ['system-ui', 'sans-serif'],
});

export const metadata: Metadata = {
  title: 'baby steps',
  description: 'Milestones, play ideas and Singapore outings for children aged 0–36 months.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icons/icon-192.png', apple: '/icons/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'baby steps', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#F6F8F1',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-SG" className={`${fraunces.variable} ${dmSans.variable}`}>
      <body>
        <AppProvider>
          <Shell>{children}</Shell>
        </AppProvider>
      </body>
    </html>
  );
}
