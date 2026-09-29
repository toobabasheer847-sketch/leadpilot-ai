import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboundRequestError, OutboundRequestService } from '../../common/outbound-request.service';
import { publicPersonEmail } from '../extraction/contact-extractor.service';
import { companyDomainFromWebsite, isPersonProfileUrl, roleMatches } from '../discovery/public-decision-maker';
import type { CompanyLike, ContactCandidate, ContactDiscoveryContext, ContactDiscoveryResult } from '../types/contact.types';
import type { ContactDiscoveryProvider } from './contact-provider.interface';

interface SnovProspect {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  position?: string;
  email?: string;
  emailStatus?: string;
  linkedinUrl?: string;
  sourceUrl?: string;
  companyName?: string;
}

/**
 * Optional Snov.io contact enrichment. Never fabricates emails or profiles.
 * Called only when website/public discovery did not yield complete decision-maker details.
 */
@Injectable()
export class SnovContactProvider implements ContactDiscoveryProvider {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly queriedDomains = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly outbound?: OutboundRequestService,
  ) {}

  providerName() {
    return 'snov';
  }

  configured(): boolean {
    return Boolean(this.clientId() && this.clientSecret() && this.outbound);
  }

  async discover(company: CompanyLike, context: ContactDiscoveryContext): Promise<ContactDiscoveryResult> {
    if (!this.configured() || context.allowProviderEnrichment === false) return { candidates: [] };
    const domain = context.companyDomain ?? companyDomainFromWebsite(company.website ?? context.companyWebsite);
    if (!domain) return { candidates: [] };
    const cacheKey = `${context.organizationId}:${domain}:${(context.decisionMakerRoles ?? []).join('|').toLowerCase()}`;
    if (this.queriedDomains.has(cacheKey)) return { candidates: [] };
    this.queriedDomains.add(cacheKey);

    try {
      const prospects = await this.searchProspects(domain, context.decisionMakerRoles ?? []);
      const candidates = prospects
        .map((prospect) => this.toCandidate(prospect, company.name, domain))
        .filter((candidate): candidate is ContactCandidate => Boolean(candidate));
      return { candidates };
    } catch {
      return { candidates: [] };
    }
  }

  /** Test helper: map a provider record without network I/O. */
  mapProspect(prospect: SnovProspect, companyName: string, domain: string): ContactCandidate | null {
    return this.toCandidate(prospect, companyName, domain);
  }

  private async searchProspects(domain: string, roles: string[]): Promise<SnovProspect[]> {
    const token = await this.accessToken();
    if (!token || !this.outbound) return [];
    const baseUrl = this.baseUrl();
    const start = await this.outbound.fetch(`${baseUrl}/v2/domain-search/prospects/start`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        domain,
        positions: roles.slice(0, 10),
        page: 1,
      }),
    }, this.timeoutMs());

    if (start.status === 429 || start.status === 402) return [];
    if (!start.ok) return [];
    const started = await start.json() as { task_hash?: string; data?: SnovProspect[]; prospects?: SnovProspect[] };
    if (Array.isArray(started.data)) return started.data;
    if (Array.isArray(started.prospects)) return started.prospects;
    const taskHash = started.task_hash;
    if (!taskHash) return [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await delay(250 * (attempt + 1));
      const result = await this.outbound.fetch(`${baseUrl}/v2/domain-search/prospects/result/${encodeURIComponent(taskHash)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }, this.timeoutMs());
      if (result.status === 429) return [];
      if (!result.ok) continue;
      const payload = await result.json() as { status?: string; data?: SnovProspect[]; prospects?: SnovProspect[] };
      if (payload.status && /progress|pending|running/i.test(payload.status)) continue;
      return payload.data ?? payload.prospects ?? [];
    }
    return [];
  }

  private toCandidate(prospect: SnovProspect, companyName: string, domain: string): ContactCandidate | null {
    const fullName = (prospect.fullName ?? [prospect.firstName, prospect.lastName].filter(Boolean).join(' ')).trim();
    const title = prospect.position?.trim() || null;
    if (!fullName || !title) return null;
    if (prospect.companyName && !companyNamesCompatible(prospect.companyName, companyName)) return null;

    const emailRaw = prospect.email?.trim() || null;
    const email = emailRaw && publicPersonEmail(emailRaw) && emailBelongsToDomain(emailRaw, domain) ? emailRaw : null;
    const linkedinUrl = prospect.linkedinUrl && isPersonProfileUrl(prospect.linkedinUrl) ? prospect.linkedinUrl : null;
    const sourceUrl = prospect.sourceUrl ?? linkedinUrl ?? `https://${domain}`;
    const retrievedAt = new Date().toISOString();
    const evidence = [
      { field: 'fullName', value: fullName, sourceUrl, evidenceExcerpt: `${fullName} — ${title}`, retrievedAt, evidenceType: 'PROVIDER_SNOV' },
      { field: 'title', value: title, sourceUrl, evidenceExcerpt: title, retrievedAt, evidenceType: 'PROVIDER_SNOV' },
      { field: 'companyRelationship', value: companyName, sourceUrl, evidenceExcerpt: prospect.companyName ?? companyName, retrievedAt, evidenceType: 'PROVIDER_SNOV' },
    ];
    if (email) evidence.push({ field: 'email', value: email, sourceUrl, evidenceExcerpt: email, retrievedAt, evidenceType: 'PROVIDER_SNOV' });
    if (linkedinUrl) evidence.push({ field: 'profileUrl', value: linkedinUrl, sourceUrl, evidenceExcerpt: linkedinUrl, retrievedAt, evidenceType: 'PROVIDER_SNOV' });

    const parts = fullName.split(/\s+/);
    return {
      fullName,
      firstName: prospect.firstName ?? parts[0],
      lastName: prospect.lastName ?? (parts.slice(1).join(' ') || null),
      title,
      originalTitle: title,
      companyRelationship: companyName,
      email,
      emailStatus: email ? mapEmailStatus(prospect.emailStatus) : 'NOT_FOUND',
      phone: null,
      phoneStatus: 'NOT_FOUND',
      linkedinUrl: linkedinUrl ?? undefined,
      companyName,
      sourceUrl,
      evidence,
      normalizedName: fullName.toLowerCase(),
      status: 'DISCOVERED',
      verificationStatus: 'NOT_VERIFIED',
    };
  }

  private async accessToken(): Promise<string | null> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    if (!this.outbound) return null;
    const clientId = this.clientId();
    const clientSecret = this.clientSecret();
    if (!clientId || !clientSecret) return null;
    try {
      const response = await this.outbound.fetch(`${this.baseUrl()}/v1/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }),
      }, this.timeoutMs());
      if (!response.ok) return null;
      const payload = await response.json() as { access_token?: string; expires_in?: number };
      if (!payload.access_token) return null;
      this.token = {
        value: payload.access_token,
        expiresAt: Date.now() + Math.max(60, Number(payload.expires_in ?? 3600)) * 1000,
      };
      return this.token.value;
    } catch (error) {
      if (error instanceof OutboundRequestError) return null;
      return null;
    }
  }

  private clientId() {
    return this.config.get<string>('contactProvider.clientId')?.trim() || undefined;
  }

  private clientSecret() {
    return this.config.get<string>('contactProvider.clientSecret')?.trim()
      || this.config.get<string>('contactProvider.apiKey')?.trim()
      || undefined;
  }

  private baseUrl() {
    return (this.config.get<string>('contactProvider.baseUrl')?.trim() || 'https://api.snov.io').replace(/\/$/, '');
  }

  private timeoutMs() {
    return this.config.get<number>('contactProvider.timeoutMs', 10000);
  }
}

export function emailBelongsToDomain(email: string, domain: string): boolean {
  const host = email.split('@')[1]?.toLowerCase();
  if (!host) return false;
  const normalized = domain.toLowerCase().replace(/^www\./, '');
  return host === normalized || host.endsWith(`.${normalized}`);
}

export function companyNamesCompatible(providerName: string, companyName: string): boolean {
  const a = providerName.toLowerCase().replace(/\b(inc|llc|ltd|gmbh|co|company)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const b = companyName.toLowerCase().replace(/\b(inc|llc|ltd|gmbh|co|company)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

/**
 * Snov email status is provider deliverability/validity — never person ownership.
 * Map to FOUND/UNVERIFIED/NOT_FOUND; verification stage owns truthful statuses.
 */
function mapEmailStatus(status?: string): 'FOUND' | 'VERIFIED' | 'UNVERIFIED' | 'NOT_FOUND' {
  if (!status) return 'UNVERIFIED';
  if (/invalid|not.?found|red/i.test(status)) return 'NOT_FOUND';
  if (/valid|green|unknown|catch.?all/i.test(status)) return 'FOUND';
  // Do not map provider "verified" to VERIFIED — that would inflate to ownership/evidence claims.
  if (/verified/i.test(status)) return 'FOUND';
  return 'UNVERIFIED';
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Prefer plan roles when ranking provider/website candidates. */
export function prioritizeByRoles(candidates: ContactCandidate[], roles: string[]): ContactCandidate[] {
  if (!roles.length) return candidates;
  return [...candidates].sort((left, right) => roleRank(left.title, roles) - roleRank(right.title, roles));
}

function roleRank(title: string | null | undefined, roles: string[]): number {
  if (!title) return roles.length + 1;
  const index = roles.findIndex((role) => roleMatches(title, [role]));
  return index >= 0 ? index : roles.length;
}
