import { useState } from 'react';
import { Bars3Icon, XMarkIcon } from '@heroicons/react/16/solid';

export default function MobileSiteMenu({ links }: { links: { label: string; href: string }[] }) {
  const [open, setOpen] = useState(false);

  return <div className="landing-mobile-menu" onKeyDown={(event) => {
    if (event.key === 'Escape') { setOpen(false); (event.currentTarget.querySelector('button') as HTMLButtonElement)?.focus(); }
  }} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button type="button" className="landing-mobile-toggle" aria-label={open ? 'Close navigation' : 'Open navigation'} aria-controls="landing-mobile-nav" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? <XMarkIcon /> : <Bars3Icon />}
    </button>
    {open && <nav id="landing-mobile-nav" className="landing-mobile-nav" aria-label="Mobile navigation">
      {links.map((link) => <a key={link.href} href={link.href} onClick={() => setOpen(false)}>{link.label}</a>)}
    </nav>}
  </div>;
}
