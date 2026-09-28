import { fillEmptyCompanyFields } from '../../sources/services/company-field-merge';
import type { MasterCandidate } from '../types/deduplication.types';
import { electMaster } from '../matching/matching';

/** Prefer verified / non-empty master values; never replace verified fields with unverified loser data. */
export function mergeCompanyScalars(
  master: {
    website?: string | null; phone?: string | null; email?: string | null; category?: string | null;
    googlePlaceId?: string | null; description?: string | null; employeeCount?: number | null; employeeRange?: string | null;
    investmentStrategy?: string | null; verificationStatus?: string | null;
  },
  loser: {
    website?: string | null; phone?: string | null; email?: string | null; category?: string | null;
    googlePlaceId?: string | null; description?: string | null; employeeCount?: number | null; employeeRange?: string | null;
    investmentStrategy?: string | null; verificationStatus?: string | null;
  },
  masterVerifiedFields: Set<string>,
): Record<string, unknown> {
  const updates: Record<string, unknown> = {
    ...fillEmptyCompanyFields(master, loser),
  };
  if (!master.description && loser.description) updates.description = loser.description;
  if (master.employeeCount == null && loser.employeeCount != null) updates.employeeCount = loser.employeeCount;
  if (!master.employeeRange && loser.employeeRange) updates.employeeRange = loser.employeeRange;
  if (!master.investmentStrategy && loser.investmentStrategy) updates.investmentStrategy = loser.investmentStrategy;

  for (const field of ['website', 'phone', 'email', 'category', 'googlePlaceId', 'description', 'employeeCount', 'employeeRange', 'investmentStrategy']) {
    if (masterVerifiedFields.has(field) && updates[field] !== undefined) delete updates[field];
  }
  return updates;
}

export function mergeContactScalars(
  master: { title?: string | null; email?: string | null; phone?: string | null; linkedinUrl?: string | null; facebookUrl?: string | null; instagramUrl?: string | null; youtubeUrl?: string | null; normalizedRole?: string | null; companyRelationship?: string | null },
  loser: { title?: string | null; email?: string | null; phone?: string | null; linkedinUrl?: string | null; facebookUrl?: string | null; instagramUrl?: string | null; youtubeUrl?: string | null; normalizedRole?: string | null; companyRelationship?: string | null },
  masterVerifiedFields: Set<string>,
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  const fill = (field: keyof typeof master) => {
    if (!master[field] && loser[field] && !masterVerifiedFields.has(field)) updates[field] = loser[field];
  };
  fill('title');
  fill('email');
  fill('phone');
  fill('linkedinUrl');
  fill('facebookUrl');
  fill('instagramUrl');
  fill('youtubeUrl');
  fill('normalizedRole');
  fill('companyRelationship');
  return updates;
}

export function electCompanyMaster(candidates: MasterCandidate[]): string {
  return electMaster(candidates);
}

export function electContactMaster(candidates: MasterCandidate[]): string {
  return electMaster(candidates);
}
