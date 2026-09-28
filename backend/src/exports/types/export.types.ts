export type ExportFormat = 'csv' | 'xlsx';
export type ExportStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';

export const EXPORT_FIELDS = [
  'companyName', 'website', 'domain', 'companyPhone', 'companyEmail', 'address', 'city', 'state', 'zipCode', 'country',
  'employeeCount', 'employeeRange', 'companySizeStatus',
  'contactName', 'contactTitle', 'contactEmail', 'contactPhone', 'linkedin', 'facebook', 'instagram',
  'decisionMakerLinkedin', 'decisionMakerFacebook', 'decisionMakerInstagram', 'decisionMakerYoutube', 'decisionMakerX',
  'companyLinkedin', 'companyFacebook', 'companyInstagram', 'companyYoutube', 'companyX',
  'investorType', 'investmentStrategy', 'propertyType', 'marketsServed', 'companySize', 'classification', 'classificationConfidence',
  'score', 'scoreBand', 'qualificationStatus', 'verificationStatus', 'evidence', 'sourceUrls', 'duplicateStatus', 'createdAt', 'updatedAt', 'lastVerifiedAt',
] as const;

export type ExportField = typeof EXPORT_FIELDS[number];

export interface ExportJobData { exportId: string; organizationId: string; }

export const DEFAULT_EXPORT_FIELDS: ExportField[] = [
  'companyName', 'website', 'companyEmail', 'companyPhone', 'address', 'city', 'state', 'zipCode', 'country',
  'employeeCount', 'employeeRange', 'companySizeStatus', 'investorType',
  'contactName', 'contactTitle', 'contactEmail',
  'decisionMakerLinkedin', 'decisionMakerFacebook', 'decisionMakerInstagram', 'decisionMakerYoutube', 'decisionMakerX',
  'companyLinkedin', 'companyFacebook', 'companyInstagram', 'companyYoutube', 'companyX',
  'qualificationStatus', 'score', 'verificationStatus',
];
