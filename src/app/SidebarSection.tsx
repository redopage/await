import { useState, type ReactNode } from 'react';
import { ChevronDownIcon } from '@heroicons/react/16/solid';

export default function SidebarSection({ id, title, icon, preferenceKey, forceOpen = false, count = 0, countLabel, action, children }: {
  id: string; title: string; icon: ReactNode; preferenceKey: string; forceOpen?: boolean;
  count?: number; countLabel?: string; action: ReactNode; children: ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(preferenceKey);
      return saved !== 'false';
    } catch { return true; }
  });
  const expanded = forceOpen || open;
  function toggle() {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(preferenceKey, String(next)); } catch { /* Keep working when browser storage is unavailable. */ }
  }
  return <section className="sidebar-section" aria-label={title}>
    <div className="sidebar-heading">
      <button type="button" className="sidebar-section-toggle" aria-label={title} aria-expanded={expanded} aria-controls={id}
        aria-describedby={!expanded && count > 0 ? `${id}-count` : undefined}
        disabled={forceOpen} title={forceOpen ? 'Clear search to collapse this section' : undefined} onClick={toggle}>
        <span className={`sidebar-section-chevron ${expanded ? 'expanded' : ''}`} aria-hidden="true"><span className="sidebar-section-icon">{icon}</span><span className="sidebar-section-caret"><ChevronDownIcon /></span></span>
        <span className="sidebar-section-title">{title}</span>
        {!expanded && count > 0 && <b id={`${id}-count`} className="sidebar-section-count" title={countLabel} aria-label={`${count} ${countLabel ?? 'notifications'}`}>{count}</b>}
      </button>
      {action}
    </div>
    <div id={id} hidden={!expanded}>{expanded && children}</div>
  </section>;
}
