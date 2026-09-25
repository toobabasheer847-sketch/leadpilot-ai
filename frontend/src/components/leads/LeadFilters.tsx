import type { SearchExecutionSummary } from '../../types/api';
import { formatWhen } from '../../lib/format';

export interface LeadFilterValues {
  search: string;
  state: string;
  city: string;
  country: string;
  zipCode: string;
  investorType: string;
  qualificationStatus: string;
  verificationStatus: string;
  classification: string;
  minScore: string;
  maxScore: string;
  scoreBand: string;
  searchExecutionId: string;
  hasDecisionMaker: string;
  hasEmail: string;
  hasPhone: string;
  companySizeStatus: string;
}

const verificationStatuses = ['VERIFIED', 'SUPPORTED', 'UNVERIFIED', 'NOT_FOUND', 'CONFLICT', 'NEEDS_REVIEW', 'INVALID', 'PARTIALLY_VERIFIED'];

export function LeadFilters({ values, executions, onSearchChange, onChange }: {
  values: LeadFilterValues;
  executions: SearchExecutionSummary[];
  onSearchChange: (value: string) => void;
  onChange: (key: keyof LeadFilterValues, value: string) => void;
}) {
  return (
    <form className="filters" onSubmit={(event) => event.preventDefault()}>
      <label>Search<input value={values.search} onChange={(event) => onSearchChange(event.target.value)} /></label>
      <label>Search execution
        <select value={values.searchExecutionId} onChange={(event) => onChange('searchExecutionId', event.target.value)}>
          <option value="">Any</option>
          {executions.map((execution) => (
            <option key={execution.id} value={execution.id}>{execution.userPrompt || `${execution.status} · ${formatWhen(execution.createdAt)}`}</option>
          ))}
        </select>
      </label>
      <label>Country<input value={values.country} onChange={(event) => onChange('country', event.target.value)} /></label>
      <label>State<input value={values.state} onChange={(event) => onChange('state', event.target.value)} /></label>
      <label>City<input value={values.city} onChange={(event) => onChange('city', event.target.value)} /></label>
      <label>ZIP<input value={values.zipCode} onChange={(event) => onChange('zipCode', event.target.value)} /></label>
      <label>Company size
        <select value={values.companySizeStatus} onChange={(event) => onChange('companySizeStatus', event.target.value)}>
          <option value="">Any</option>
          <option value="MATCHED">MATCHED 1-50</option>
          <option value="UNKNOWN">UNKNOWN</option>
          <option value="OUTSIDE_RANGE">OUTSIDE RANGE</option>
        </select>
      </label>
      <label>Investor type
        <select value={values.investorType} onChange={(event) => onChange('investorType', event.target.value)}>
          <option value="">Any</option>
          <option value="CASH_HOME_BUYER">CASH_HOME_BUYER</option>
          <option value="FIX_AND_FLIP">FIX_AND_FLIP</option>
          <option value="BUY_AND_HOLD">BUY_AND_HOLD</option>
          <option value="BRRRR">BRRRR</option>
          <option value="COMMERCIAL_INVESTOR">COMMERCIAL_INVESTOR</option>
          <option value="LAND_INVESTOR">LAND_INVESTOR</option>
          <option value="MULTIFAMILY_INVESTOR">MULTIFAMILY_INVESTOR</option>
          <option value="REAL_ESTATE_INVESTOR_OTHER">REAL_ESTATE_INVESTOR_OTHER</option>
          <option value="NOT_DETERMINED">NOT_DETERMINED</option>
        </select>
      </label>
      <label>Qualification
        <select value={values.qualificationStatus} onChange={(event) => onChange('qualificationStatus', event.target.value)}>
          <option value="">Any</option>
          <option value="QUALIFIED">QUALIFIED</option>
          <option value="NOT_QUALIFIED">NOT_QUALIFIED</option>
          <option value="NEEDS_REVIEW">NEEDS_REVIEW</option>
        </select>
      </label>
      <label>Classification
        <select value={values.classification} onChange={(event) => onChange('classification', event.target.value)}>
          <option value="">Any</option>
          <option value="QUALIFIED">QUALIFIED</option>
          <option value="NOT_QUALIFIED">NOT_QUALIFIED</option>
          <option value="INSUFFICIENT_EVIDENCE">INSUFFICIENT_EVIDENCE</option>
        </select>
      </label>
      <label>Verification
        <select value={values.verificationStatus} onChange={(event) => onChange('verificationStatus', event.target.value)}>
          <option value="">Any</option>
          {verificationStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
      </label>
      <label>Score band
        <select value={values.scoreBand} onChange={(event) => onChange('scoreBand', event.target.value)}>
          <option value="">Any</option>
          <option value="LOW">LOW</option>
          <option value="MEDIUM">MEDIUM</option>
          <option value="HIGH">HIGH</option>
          <option value="VERY_HIGH">VERY_HIGH</option>
        </select>
      </label>
      <label>Minimum score<input type="number" min={0} max={100} value={values.minScore} onChange={(event) => onChange('minScore', event.target.value)} /></label>
      <label>Maximum score<input type="number" min={0} max={100} value={values.maxScore} onChange={(event) => onChange('maxScore', event.target.value)} /></label>
      <label>Decision maker
        <select value={values.hasDecisionMaker} onChange={(event) => onChange('hasDecisionMaker', event.target.value)}>
          <option value="">Any</option>
          <option value="true">Has a decision maker</option>
          <option value="false">No decision maker</option>
        </select>
      </label>
      <label>Email
        <select value={values.hasEmail} onChange={(event) => onChange('hasEmail', event.target.value)}>
          <option value="">Any</option>
          <option value="true">Has email</option>
          <option value="false">No email</option>
        </select>
      </label>
      <label>Phone
        <select value={values.hasPhone} onChange={(event) => onChange('hasPhone', event.target.value)}>
          <option value="">Any</option>
          <option value="true">Has phone</option>
          <option value="false">No phone</option>
        </select>
      </label>
    </form>
  );
}
