import { businessValue, listLabel } from '../../lib/format';
import type { CompanyOverviewData } from '../../lib/company-view';
import { ExternalLink } from './ExternalLink';

export function CompanyOverview({ company }: { company: CompanyOverviewData }) {
  const rows: Array<[string, string | null, 'link' | 'text' | 'list']> = [
    ['Company name', company.name, 'text'],
    ['Official website', company.website, 'link'],
    ['Description', company.description, 'text'],
    ['Category', company.category, 'text'],
    ['Investor type', company.investorType, 'text'],
    ['Address', company.address, 'text'],
    ['City', company.city, 'text'],
    ['State', company.state, 'text'],
    ['ZIP', company.zipCode, 'text'],
    ['Country', company.country, 'text'],
    ['Phone', company.phone, 'text'],
    ['Email', company.email, 'text'],
    ['Markets served', null, 'list'],
    ['Property types', null, 'list'],
    ['Investment strategy', company.investmentStrategy, 'text'],
  ];
  return (
    <dl className="kv">
      {rows.map(([label, value, kind]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>
            {kind === 'link' ? <ExternalLink href={value} /> : null}
            {kind === 'text' ? businessValue(value) : null}
            {kind === 'list' ? listLabel(label === 'Markets served' ? company.marketsServed : company.propertyTypes) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
