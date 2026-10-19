'use client';

import { useEffect, useState } from 'react';
import { useApp } from './AppProvider';
import { CloseIcon } from './icons';

interface BIPEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** "Add to Home Screen" prompt from the 2nd visit (SDD §4.3, §6.3). */
export function InstallPrompt() {
  const { state, dismissInstall } = useApp();
  const [bip, setBip] = useState<BIPEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [standalone, setStandalone] = useState(true);

  useEffect(() => {
    const nav = navigator as Navigator & { standalone?: boolean };
    setStandalone(window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true);
    setIos(/iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent));
    const onBip = (e: Event) => { e.preventDefault(); setBip(e as BIPEvent); };
    window.addEventListener('beforeinstallprompt', onBip);
    return () => window.removeEventListener('beforeinstallprompt', onBip);
  }, []);

  if (standalone || state.installDismissed || state.visits < 2 || (!bip && !ios)) return null;

  return (
    <div className="install" role="region" aria-label="Add to Home Screen">
      <span aria-hidden="true" style={{ fontSize: 24 }}>🌱</span>
      {bip ? (
        <>
          <p>Add baby steps to your Home Screen so your saved ideas stay on this phone.</p>
          <button type="button" className="btn" onClick={async () => { await bip.prompt(); await bip.userChoice; dismissInstall(); }}>Add</button>
        </>
      ) : (
        <p>Keep your saved ideas: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</p>
      )}
      <button type="button" className="heart" aria-label="Dismiss" onClick={dismissInstall} style={{ color: 'var(--ink-muted)' }}>
        <CloseIcon />
      </button>
    </div>
  );
}
