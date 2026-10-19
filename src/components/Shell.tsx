'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useApp } from './AppProvider';
import { Onboarding } from './Onboarding';
import { InstallPrompt } from './InstallPrompt';
import { SearchIcon } from './icons';
import { noteNavigation } from '@/lib/nav';

const SearchOverlay = dynamic(() => import('./SearchOverlay'), { ssr: false });

const NAV = [
  { href: '/', label: 'Playtime', ico: '☀️', match: (p: string) => p === '/' || p.startsWith('/activity') },
  { href: '/milestones/', label: 'Milestones', ico: '🌱', match: (p: string) => p.startsWith('/milestone') },
  { href: '/for-you/', label: 'For You', ico: '♥', match: (p: string) => p.startsWith('/for-you') },
  { href: '/outings/', label: 'Outings', ico: '🧺', match: (p: string) => p.startsWith('/outing') },
];

export function Shell({ children }: { children: ReactNode }) {
  const { ready, state, searchOpen, setSearchOpen } = useApp();
  const pathname = usePathname() || '/';

  useEffect(() => { noteNavigation(); }, [pathname]);

  // Register the service worker (production builds only).
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);

  // "/" opens search from anywhere (desktop convenience).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === '/' && !searchOpen && !(t && /INPUT|TEXTAREA|SELECT/.test(t.tagName))) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen, setSearchOpen]);

  if (ready && !state.birth && !pathname.startsWith('/settings')) return <Onboarding />;

  return (
    <div className="shell">
      <a href="#main" className="sr-only">Skip to content</a>
      <header className="topbar">
        <Link href="/" className="logo" aria-label="baby steps home">baby <span>steps</span></Link>
        <button type="button" className="search" onClick={() => setSearchOpen(true)}>
          <SearchIcon width={18} height={18} /> Search activities, milestones, outings
        </button>
      </header>
      <nav className="sidebar" aria-label="Main">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} aria-current={n.match(pathname) ? 'page' : undefined}>
            <span aria-hidden="true">{n.ico}</span> {n.label}
          </Link>
        ))}
        <Link href="/settings/" aria-current={pathname.startsWith('/settings') ? 'page' : undefined}>
          <span aria-hidden="true">⚙️</span> Settings
        </Link>
      </nav>
      <main id="main" className="main">
        <div className="page">{ready ? children : <PageSkeleton />}</div>
      </main>
      <nav className="bottomnav" aria-label="Main">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} aria-current={n.match(pathname) ? 'page' : undefined}>
            <span className="ico" aria-hidden="true">{n.ico}</span>
            {n.label}
          </Link>
        ))}
      </nav>
      {ready && <InstallPrompt />}
      {searchOpen && <SearchOverlay onClose={() => setSearchOpen(false)} />}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="skeleton" style={{ height: 56, margin: '12px 0', width: '55%' }} />
      <div className="skeleton" style={{ height: 48, marginBottom: 14 }} />
      <div className="skeleton" style={{ height: 180, marginBottom: 12 }} />
      <div className="skeleton" style={{ height: 80, marginBottom: 10 }} />
      <div className="skeleton" style={{ height: 80 }} />
    </div>
  );
}
