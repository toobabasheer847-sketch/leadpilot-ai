import { formatCompanySize } from '../../lib/company-size';
import type { EvidenceItem, LeadRecord, VerificationConflict } from '../../types/api';
import { ExternalLink } from './ExternalLink';

export function EmployeeSizeCard({ company, evidence, conflicts }: {
  company: LeadRecord['company'];
  evidence: EvidenceItem[];
  conflicts: VerificationConflict[];
}) {
  const rows = evidence.filter((item) => item.evidenceType === 'EMPLOYEE_SIZE' || metadata(item).field === 'companySize');
  const sizeConflicts = conflicts.filter((conflict) => conflict.fieldName === 'companySize');
  const status = sizeConflicts.length > 0 ? 'CONFLICT' : company.companySizeStatus;
  return (
    <div className="stack">
      <p>Employee size {formatCompanySize(status, company.companySize)}</p>
      {rows.length === 0 ? <p>No employee-size evidence stored.</p> : null}
      {rows.map((item) => {
        const details = metadata(item);
        return (
          <article key={item.id ?? `${item.sourceUrl}-${details.value ?? ''}`}>
            <p>Value {formatCompanySize(null, typeof details.value === 'string' || typeof details.value === 'number' ? details.value : null)}</p>
            <p>Source {typeof details.sourceType === 'string' ? details.sourceType : item.sourceType ?? 'UNKNOWN'}</p>
            <p><ExternalLink href={item.sourceUrl ?? (typeof details.sourceUrl === 'string' ? details.sourceUrl : null)} /></p>
            <p>{item.evidenceText ?? item.excerpt ?? (typeof details.evidenceExcerpt === 'string' ? details.evidenceExcerpt : 'Not available')}</p>
            <p>Verification {typeof details.verificationStatus === 'string' ? details.verificationStatus : details.verified === true ? 'VERIFIED' : 'UNVERIFIED'}</p>
          </article>
        );
      })}
      {sizeConflicts.map((conflict) => (
        <article key={conflict.id}>
          <p>Conflict {conflict.status}</p>
          <p>{conflict.valueA} and {conflict.valueB}</p>
          <p>{conflict.evidenceExcerptA}</p>
          <p>{conflict.evidenceExcerptB}</p>
        </article>
      ))}
    </div>
  );
}

function metadata(item: EvidenceItem): Record<string, unknown> {
  return typeof item.metadata === 'object' && item.metadata !== null ? item.metadata as Record<string, unknown> : {};
}
