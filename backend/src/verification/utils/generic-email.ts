/** Shared mailbox local-parts that must stay company-level, never person-level. */
export const GENERIC_EMAIL_LOCAL_PARTS = new Set([
  'info', 'contact', 'hello', 'office', 'support', 'sales', 'admin', 'team',
  'inquiries', 'enquiry', 'enquiries', 'noreply', 'no-reply', 'careers', 'jobs',
  'billing', 'accounts', 'hr', 'press', 'media', 'help',
]);

export function isGenericBusinessEmail(email: string | null | undefined): boolean {
  if (!email?.trim()) return false;
  const local = email.split('@')[0]?.toLowerCase().trim();
  if (!local) return false;
  return GENERIC_EMAIL_LOCAL_PARTS.has(local) || local.includes('noreply') || local.includes('no-reply');
}

export function emailLocalPart(email: string): string {
  return email.split('@')[0]?.toLowerCase().trim() ?? '';
}
