import type { ReactNode } from 'react';
import { onLinkClick } from '../router';

/** A clickable tile; `to` is the hash route of its detail. */
export function Tile({ to, selected, children, label }: { to: string; selected: boolean; children: ReactNode; label?: string }) {
  return (
    <a href={to} className={`tile${selected ? ' on' : ''}`} aria-current={selected ? 'true' : undefined}
      aria-label={label} onClick={onLinkClick}>
      {children}
    </a>
  );
}
