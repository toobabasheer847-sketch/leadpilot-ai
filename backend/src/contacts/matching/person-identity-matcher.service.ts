import { Injectable } from '@nestjs/common';
import { ContactCandidate, IdentityMatchResult } from '../types/contact.types';

@Injectable()
export class PersonIdentityMatcherService {
  match(first: ContactCandidate, second: ContactCandidate): IdentityMatchResult {
    const signals: string[] = [];
    const sameCompany = first.companyName.toLowerCase() === second.companyName.toLowerCase();
    const sameWebsite = (() => {
      try { return new URL(first.sourceUrl).origin === new URL(second.sourceUrl).origin; } catch { return false; }
    })();
    const titleMatch = first.title && second.title && first.title.toLowerCase() === second.title.toLowerCase();
    const nameSimilarity = this.nameSimilarity(first.fullName, second.fullName);

    if (sameCompany) signals.push('same company');
    if (titleMatch) signals.push('same title');
    if (sameWebsite) signals.push('same website');
    if (nameSimilarity > 0.7) signals.push('similar name');

    const score = Number(
      (Number(sameCompany) * 0.35)
      + (Number(titleMatch) * 0.25)
      + (Number(sameWebsite) * 0.2)
      + (Math.min(nameSimilarity, 1) * 0.2),
    );

    const samePerson = sameCompany && nameSimilarity > 0.75 && (titleMatch || sameWebsite || first.sourceUrl === second.sourceUrl);
    return {
      samePerson: Boolean(samePerson),
      confidence: Number(score.toFixed(2)),
      signals,
    };
  }

  private nameSimilarity(first: string, second: string): number {
    const a = first.toLowerCase().split(/\s+/).filter(Boolean);
    const b = second.toLowerCase().split(/\s+/).filter(Boolean);
    if (!a.length || !b.length) return 0;
    const common = a.filter((token) => b.includes(token)).length;
    const union = new Set([...a, ...b]).size;
    return union === 0 ? 0 : common / union;
  }
}
