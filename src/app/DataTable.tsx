import type { ReactNode } from 'react';

type Props = { label: string; children: ReactNode };

export default function DataTable({ label, children }: Props) {
  return <div className="data-table-scroll"><div className="data-table-inner"><table className="data-table" aria-label={label}>{children}</table></div></div>;
}
