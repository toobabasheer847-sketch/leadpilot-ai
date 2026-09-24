import type { ReactNode } from 'react';
import { businessValue } from '../../lib/format';

export function ExternalLink({ href, children }: { href: string | null | undefined; children?: ReactNode }) {
  if (!href || !/^https?:\/\//i.test(href)) return <span>{businessValue(href)}</span>;
  return <a href={href} target="_blank" rel="noopener noreferrer">{children ?? href}</a>;
}
