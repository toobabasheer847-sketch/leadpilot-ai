import type { DecisionMaker, SocialProfileMap, SocialProfileRow } from '../types/api';

export interface SocialLinkItem {
  platform: string;
  url: string;
  status: string | null;
}

export function collectSocialLinks(input: {
  rows?: SocialProfileRow[] | null;
  map?: SocialProfileMap | null;
  contact?: Pick<DecisionMaker, 'linkedinUrl' | 'facebookUrl' | 'instagramUrl' | 'youtubeUrl' | 'socialProfileStatus'> | null;
}): SocialLinkItem[] {
  const items: SocialLinkItem[] = [];
  const seen = new Set<string>();
  function add(platform: string, url: string | null | undefined, status?: string | null) {
    if (!url || !url.trim()) return;
    const key = url.trim();
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ platform, url: key, status: status ?? null });
  }
  for (const row of input.rows ?? []) add(row.platform || 'Profile', row.profileUrl, row.verificationStatus);
  for (const [platform, url] of Object.entries(input.map ?? {})) add(platform, url);
  const contact = input.contact;
  if (contact) {
    add('LinkedIn', contact.linkedinUrl, contact.socialProfileStatus?.linkedin);
    add('Facebook', contact.facebookUrl, contact.socialProfileStatus?.facebook);
    add('Instagram', contact.instagramUrl, contact.socialProfileStatus?.instagram);
    add('YouTube', contact.youtubeUrl, contact.socialProfileStatus?.youtube);
  }
  return items;
}
