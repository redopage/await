import { useEffect, useRef, useState, type ReactNode } from 'react';
import { XMarkIcon } from '@heroicons/react/16/solid';

export default function Modal({ title, children, onClose, className = '', hideHeader = false }: { title: string; children: ReactNode; onClose: () => void; className?: string; hideHeader?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  const [returnFocus] = useState(() => {
    const active = document.activeElement as HTMLElement | null;
    return active?.closest('[role="menu"], .profile-popover')?.parentElement?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"], button.profile-row') ?? active;
  });
  close.current = onClose;
  useEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'))
      .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
    const focusFirst = () => (focusable()[0] ?? panel).focus();
    if (!panel.contains(document.activeElement)) focusFirst();
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) { event.preventDefault(); panel.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) { event.preventDefault(); first.focus(); }
    };
    const focus = (event: FocusEvent) => { if (!panel.contains(event.target as Node)) focusFirst(); };
    document.addEventListener('keydown', key);
    document.addEventListener('focusin', focus);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('focusin', focus);
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [returnFocus]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close.current(); }}>
    <section ref={ref} className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      {!hideHeader && <div className="modal-header"><h2>{title}</h2><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><XMarkIcon /></button></div>}
      {children}
    </section>
  </div>;
}
