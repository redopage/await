export default function BrandMark({ className = '' }: { className?: string }) {
  return <span className={`mark ${className}`} aria-hidden="true"><span className="mark-lockup"><span className="mark-letter">a</span><span className="mark-dot" /></span></span>;
}
