export interface CompanyFieldSnapshot {
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  category?: string | null;
  googlePlaceId?: string | null;
}

export function fillEmptyCompanyFields(existing: CompanyFieldSnapshot, incoming: CompanyFieldSnapshot): Partial<CompanyFieldSnapshot> {
  const updates: Partial<CompanyFieldSnapshot> = {};
  if (!existing.website && incoming.website) updates.website = incoming.website;
  if (!existing.phone && incoming.phone) updates.phone = incoming.phone;
  if (!existing.email && incoming.email) updates.email = incoming.email;
  if (!existing.category && incoming.category) updates.category = incoming.category;
  if (!existing.googlePlaceId && incoming.googlePlaceId) updates.googlePlaceId = incoming.googlePlaceId;
  return updates;
}

export function phoneMatchKey(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 ? digits : null;
}
