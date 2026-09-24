import { ValidationPipe } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { DRIZZLE } from '../src/database/database.constants';
import type { Database } from '../src/database/database.types';
import { companies, companyContacts, leadEvidence } from '../src/database/schema/schema';

process.env.SOURCE_PROVIDER = 'fake';
process.env.WEBSITE_FETCH_TIMEOUT_MS = '1000';

describe('Contact quality verification (e2e)', () => {
  let app: INestApplication<App>;
  let database: Database;
  let token: string;
  let otherToken: string;
  let companyId: string;
  let contactId: string;
  const unique = randomUUID().slice(0, 8);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [await import('../src/app.module').then((module) => module.AppModule)],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    database = app.get<Database>(DRIZZLE);
    await app.init();

    const owner = await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      name: 'Contact Quality User',
      email: `quality-${unique}@example.com`,
      password: 'StrongPassword123!',
      organizationName: `Quality Organization ${unique}`,
    }).expect(201);
    token = owner.body.accessToken;
    const other = await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      name: 'Other Quality User',
      email: `quality-other-${unique}@example.com`,
      password: 'StrongPassword123!',
      organizationName: `Other Quality Organization ${unique}`,
    }).expect(201);
    otherToken = other.body.accessToken;

    const [company] = await database.insert(companies).values({
      organizationId: owner.body.user.organization.id,
      name: `Fixture Northwind Buyers ${unique}`,
      website: 'https://fixture-northwind.test',
      verificationStatus: 'NOT_VERIFIED',
    }).returning();
    companyId = company.id;
    const [contact] = await database.insert(companyContacts).values({
      companyId,
      fullName: 'Ada Example',
      title: 'Founder',
      emailStatus: 'NOT_FOUND',
      phoneStatus: 'NOT_FOUND',
      verificationStatus: 'NOT_VERIFIED',
    }).returning();
    contactId = contact.id;
    const retrievedAt = new Date();
    await database.insert(leadEvidence).values([
      {
        companyId,
        contactId,
        evidenceType: 'COMPANY_WEBSITE',
        sourceType: 'WEBSITE',
        sourceUrl: 'https://fixture-northwind.test/about',
        evidenceText: `Ada Example is Founder of Fixture Northwind Buyers ${unique}.`,
        evidenceTimestamp: retrievedAt,
        idempotencyKey: `quality-fixture-founder-${unique}`,
        metadata: { field: 'title', value: 'Founder', evidenceExcerpt: `Ada Example is Founder of Fixture Northwind Buyers ${unique}.` },
      },
      {
        companyId,
        contactId,
        evidenceType: 'PUBLIC_INTERVIEW',
        sourceType: 'INTERVIEW',
        sourceUrl: 'https://fixture-profile.test/interview',
        evidenceText: `Ada Example, Former CEO of Fixture Northwind Buyers ${unique}.`,
        evidenceTimestamp: retrievedAt,
        idempotencyKey: `quality-fixture-former-${unique}`,
        metadata: { field: 'title', value: 'Former CEO', evidenceExcerpt: `Ada Example, Former CEO of Fixture Northwind Buyers ${unique}.` },
      },
    ]);
  }, 60000);

  afterAll(async () => {
    await app.close();
  });

  it('verifies a fixture contact, preserves the title conflict, and isolates organizations', async () => {
    const queued = await request(app.getHttpServer())
      .post(`/api/v1/companies/${companyId}/contacts/${contactId}/reverify`)
      .set('Authorization', `Bearer ${token}`)
      .expect(202);
    expect(queued.body.status).toBe('QUEUED');
    expect(queued.body.jobId).toEqual(expect.any(String));
    expect(queued.body.jobId).not.toContain(':');

    const detail = await waitForContact();
    expect(detail.name).toBe('Ada Example');
    expect(detail.title).toBe('Founder');
    expect(detail.fields?.title?.status ?? detail.quality.fields.title.status).toBe('CONFLICT');
    expect(detail.emailStatus).toBe('NOT_FOUND');
    expect(detail.quality.conflicts[0].requiresReview).toBe(true);
    expect(detail.quality.autoMerged).toBe(false);
    expect(detail.evidence).toHaveLength(2);

    const evidence = await request(app.getHttpServer())
      .get(`/api/v1/contacts/${contactId}/evidence`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(evidence.body).toHaveLength(2);

    const list = await request(app.getHttpServer())
      .get(`/api/v1/companies/${companyId}/contacts`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body[0].socialProfileStatus.linkedin).toBe('NOT_FOUND');
    expect(list.body[0].lastVerifiedAt).toEqual(expect.any(String));

    await request(app.getHttpServer())
      .get(`/api/v1/companies/${companyId}/contacts/${contactId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/v1/companies/${companyId}/contacts/${contactId}/reverify`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
  }, 60000);

  async function waitForContact() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/companies/${companyId}/contacts/${contactId}`)
        .set('Authorization', `Bearer ${token}`);
      if (response.status === 200 && response.body.lastVerifiedAt) return response.body;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Contact quality verification did not finish');
  }
});
