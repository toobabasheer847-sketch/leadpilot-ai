import { EmptyState, StatusBadge } from '../feedback/States';
import type { SocialLinkItem } from '../../lib/social';
import { ExternalLink } from './ExternalLink';

export function SocialLinks({ links }: { links: SocialLinkItem[] }) {
  if (!links.length) return <EmptyState title="No social profiles returned" detail="Profile links appear when the backend returns a URL." />;
  return (
    <ul className="plain-list">
      {links.map((link) => (
        <li key={`${link.platform}-${link.url}`}>
          <span>{link.platform}</span>
          <ExternalLink href={link.url} />
          {link.status ? <StatusBadge status={link.status} /> : null}
        </li>
      ))}
    </ul>
  );
}
