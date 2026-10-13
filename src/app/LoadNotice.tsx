import { ExclamationTriangleIcon } from '@heroicons/react/16/solid';

export default function LoadNotice({ title, detail, onRetry, compact = false }: { title: string; detail: string; onRetry: () => void; compact?: boolean }) {
  return <div className={`empty-state load-notice ${compact ? 'load-notice-compact' : ''}`} role="alert">{!compact && <span className="empty-icon" aria-hidden="true"><ExclamationTriangleIcon /></span>}<strong>{title}</strong><p>{detail}</p><button type="button" className="button secondary" onClick={onRetry}>Try again</button></div>;
}
