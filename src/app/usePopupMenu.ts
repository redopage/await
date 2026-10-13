import { useEffect, useRef } from 'react';

export default function usePopupMenu(open: boolean, setOpen: (open: boolean) => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const container = ref.current;
    if (!container) return;
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    const items = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    items()[0]?.focus();
    const outside = (event: PointerEvent) => {
      if (!container.contains(event.target as Node)) setOpen(false);
    };
    const focusOutside = (event: FocusEvent) => {
      if (!container.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (!container.contains(event.target as Node)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger?.focus();
      } else if (event.key === 'Tab') {
        setOpen(false);
        trigger?.focus();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = items();
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', focusOutside);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', focusOutside);
      document.removeEventListener('keydown', key);
      if (document.activeElement === document.body) trigger?.focus();
    };
  }, [open, setOpen]);
  return ref;
}
