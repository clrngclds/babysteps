'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useApp } from './AppProvider';
import { BackIcon, GearIcon, SearchIcon } from './icons';
import { hasInAppHistory } from '@/lib/nav';

interface Props {
  title?: ReactNode;
  sub?: ReactNode;
  back?: { href: string; label: string };
  /** hide the settings icon (e.g. on the Settings page) */
  noSettings?: boolean;
}

export function PageHeader({ title, sub, back, noSettings }: Props) {
  const { setSearchOpen } = useApp();
  const router = useRouter();
  return (
    <div className="top">
      <div style={{ minWidth: 0 }}>
        {back && (
          <Link
            href={back.href}
            className="back"
            onClick={(e) => {
              // Prefer real history so the previous screen keeps its scroll/month.
              if (hasInAppHistory()) {
                e.preventDefault();
                router.back();
              }
            }}
          >
            <BackIcon width={18} height={18} /> {back.label}
          </Link>
        )}
        {title && <h1>{title}</h1>}
        {sub && <p className="sub">{sub}</p>}
      </div>
      <div className="icons">
        <button type="button" className="iconbtn" aria-label="Search" onClick={() => setSearchOpen(true)}>
          <span><SearchIcon width={18} height={18} /></span>
        </button>
        {!noSettings && (
          <Link href="/settings/" className="iconbtn" aria-label="Settings">
            <span><GearIcon width={18} height={18} /></span>
          </Link>
        )}
      </div>
    </div>
  );
}
