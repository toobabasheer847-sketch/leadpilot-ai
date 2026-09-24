import type { DecisionMaker } from '../../types/api';
import { StatusBadge } from '../feedback/States';
import { businessValue } from '../../lib/format';
import { collectSocialLinks } from '../../lib/social';
import { ContactCard } from './ContactCard';
import { ExternalLink } from './ExternalLink';
import { SocialLinks } from './SocialLinks';

export function DecisionMakerCard({ person }: { person: DecisionMaker }) {
  const name = person.fullName ?? person.name ?? null;
  const evidenceCount = typeof person.evidenceSummary?.independentSources === 'number' ? person.evidenceSummary.independentSources : null;
  const links = collectSocialLinks({ contact: person }).filter((link) => link.platform !== 'LinkedIn');
  return (
    <article className="panel person-card">
      <h3>{businessValue(name)}</h3>
      <p>{businessValue(person.title)}</p>
      <p className="muted">Professional profile</p>
      <ExternalLink href={person.linkedinUrl} />
      <ContactCard email={person.email} emailStatus={person.emailStatus} phone={person.phone} phoneStatus={person.phoneStatus} />
      {links.length ? <SocialLinks links={links} /> : <p>Social profiles Not Found</p>}
      <p>Verification <StatusBadge status={person.verificationStatus} /></p>
      <p>Evidence count {evidenceCount === null ? 'Not available' : evidenceCount}</p>
    </article>
  );
}
