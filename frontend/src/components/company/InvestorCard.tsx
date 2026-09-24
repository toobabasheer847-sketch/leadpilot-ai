import type { ClassificationRecord, LeadRecord, VerificationSummary } from '../../types/api';
import { StatusBadge } from '../feedback/States';
import { businessValue } from '../../lib/format';

export function InvestorCard({ classification, lead, evidenceCount }: {
  classification: ClassificationRecord | null;
  lead: LeadRecord;
  evidenceCount: number | null;
}) {
  return (
    <dl className="kv">
      <div><dt>Investor type</dt><dd>{businessValue(classification?.investorType ?? lead.company.investorType)}</dd></div>
      <div><dt>Classification</dt><dd><StatusBadge status={classification?.decision ?? classification?.classification} /></dd></div>
      <div><dt>Confidence</dt><dd>{businessValue(classification?.confidence)}</dd></div>
      <div><dt>Qualification</dt><dd><StatusBadge status={lead.qualification?.status} /></dd></div>
      <div><dt>Evidence</dt><dd>{evidenceCount === null ? 'Not available' : `${evidenceCount} sources`}</dd></div>
    </dl>
  );
}

export function evidenceTotal(summary: VerificationSummary | null, fallback: number): number | null {
  if (summary && typeof summary.evidenceCount === 'number') return summary.evidenceCount;
  return fallback;
}
