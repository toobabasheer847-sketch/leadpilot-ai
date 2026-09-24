import { Inject, Injectable } from '@nestjs/common';
import { and, eq, desc } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { companies, companyLocations, companySocialProfiles, sourceRecords } from '../../database/schema/schema';

@Injectable()
export class CompanyEnrichmentRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findCompanyForOrganization(companyId: string, organizationId: string) {
    const [company] = await this.db.select().from(companies).where(and(
      eq(companies.id, companyId),
      eq(companies.organizationId, organizationId),
    )).limit(1);
    return company ?? null;
  }

  async findCompanyWithLocation(companyId: string, organizationId: string) {
    const [company] = await this.db.select({
      company: companies,
      location: companyLocations,
    }).from(companies)
      .leftJoin(companyLocations, and(
        eq(companyLocations.companyId, companies.id),
        eq(companyLocations.isPrimary, true),
      ))
      .where(and(
        eq(companies.id, companyId),
        eq(companies.organizationId, organizationId),
      ))
      .limit(1);
    return company ?? null;
  }

  async getSocialProfiles(companyId: string, organizationId: string) {
    const rows = await this.db.select({
      id: companySocialProfiles.id,
      platform: companySocialProfiles.platform,
      profileUrl: companySocialProfiles.profileUrl,
      username: companySocialProfiles.username,
      createdAt: companySocialProfiles.createdAt,
    }).from(companySocialProfiles)
      .innerJoin(companies, eq(companies.id, companySocialProfiles.companyId))
      .where(and(
        eq(companySocialProfiles.companyId, companyId),
        eq(companies.organizationId, organizationId),
      ));
    return rows;
  }

  async getEvidence(companyId: string, organizationId: string) {
    const rows = await this.db.select().from(sourceRecords)
      .innerJoin(companies, eq(companies.id, sourceRecords.companyId))
      .where(and(
        eq(sourceRecords.companyId, companyId),
        eq(companies.organizationId, organizationId),
      ));
    return rows;
  }

  async updateCompany(companyId: string, values: Partial<typeof companies.$inferInsert>) {
    const [updated] = await this.db.update(companies).set(values).where(eq(companies.id, companyId)).returning();
    return updated ?? null;
  }

  async upsertSocialProfile(companyId: string, platform: string, profileUrl: string, username?: string | null) {
    const [existing] = await this.db.select().from(companySocialProfiles).where(and(
      eq(companySocialProfiles.companyId, companyId),
      eq(companySocialProfiles.platform, platform),
      eq(companySocialProfiles.profileUrl, profileUrl),
    )).limit(1);

    if (existing) {
      return existing;
    }

    const [created] = await this.db.insert(companySocialProfiles).values({
      companyId,
      platform,
      profileUrl,
      username: username ?? null,
      verificationStatus: 'NOT_VERIFIED',
    }).returning();
    return created;
  }

  async findLatestSearchExecutionId(companyId: string, organizationId: string): Promise<string | null> {
    const [row] = await this.db.select({
      searchExecutionId: sourceRecords.searchExecutionId,
    }).from(sourceRecords)
      .innerJoin(companies, eq(companies.id, sourceRecords.companyId))
      .where(and(
        eq(sourceRecords.companyId, companyId),
        eq(companies.organizationId, organizationId),
      ))
      .orderBy(desc(sourceRecords.createdAt))
      .limit(1);
    return row?.searchExecutionId ?? null;
  }
}
