import { ValidationPipe } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { DRIZZLE } from '../src/database/database.constants';
import type { Database } from '../src/database/database.types';
import { companies, companyContacts, companyLocations, leadEvidence, leadVerifications } from '../src/database/schema/schema';
import { eq } from 'drizzle-orm';

process.env.SOURCE_PROVIDER = 'fake';
process.env.WEBSITE_FETCH_TIMEOUT_MS = '1000';

describe('Deep company research (e2e)', () => {
  let app: INestApplication<App>;
  let database: Database;
  let fixture: Server;
  let token: string;
  let otherToken: string;
  let companyId: string;
  const unique = randomUUID().slice(0, 8);
  const companyName = `Fixture Research Company ${unique}`;

  beforeAll(async () => {
    fixture = createServer((req, response) => {
      const url = req.url ?? '/';
      response.setHeader('content-type', url === '/robots.txt' ? 'text/plain' : 'text/html');
      if (url === '/robots.txt') {
        response.end('User-agent: *\nDisallow:\n');
        return;
      }
      if (url.startsWith('/about')) {
        response.end(`<html><body><p>Ada Example is the Founder of ${companyName}.</p><a href="https://www.linkedin.com/company/fixture-research">Profile</a></body></html>`);
        return;
      }
      if (url.startsWith('/contact')) {
        response.end(`<html><body><p>Email hello@fixture-research.test or call +1 415 555 0199.</p><p>100 Public Street, Austin, TX 78701</p></body></html>`);
        return;
      }
      response.end(`<html><head><meta name="description" content="${companyName} acquires residential properties."></head><body><p>${companyName} publishes public company information.</p><p>Services: residential acquisitions.</p><p>Markets served: Texas.</p><p>Property types: single family homes.</p><p>We buy houses for cash.</p><a href="/about">About</a><a href="/contact">Contact</a></body></html>`);
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const port = (fixture.address() as AddressInfo).port;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [await import('../src/app.module').then((module) => module.AppModule)],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    database = app.get<Database>(DRIZZLE);
    await app.init();

    const owner = await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      name: 'Research User',
      email: `research-${unique}@example.com`,
      password: 'StrongPassword123!',
      organizationName: `Research Organization ${unique}`,
    }).expect(201);
    token = owner.body.accessToken;
    const other = await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      name: 'Other Research User',
      email: `research-other-${unique}@example.com`,
      password: 'StrongPassword123!',
      organizationName: `Other Research Organization ${unique}`,
    }).expect(201);
    otherToken = other.body.accessToken;
    const [company] = await database.insert(companies).values({
      organizationId: owner.body.user.organization.id,
      name: companyName,
      website: `http://127.0.0.1:${port}/`,
      verificationStatus: 'NOT_VERIFIED',
    }).returning();
    companyId = company.id;
  }, 60000);

  afterAll(async () => {
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await app.close();
  });

  it('researches a fixture website and isolates the execution by organization', async () => {
    const started = await request(app.getHttpServer()).post(`/api/v1/companies/${companyId}/research`).set('Authorization', `Bearer ${token}`).expect(202);
    expect(started.body.researchExecutionId).toEqual(expect.any(String));
    expect(started.body.status).toBe('QUEUED');

    const detail = await waitForResearch(started.body.researchExecutionId);
    expect(['COMPLETED', 'PARTIAL']).toContain(detail.status);
    expect(detail.progress.pagesDiscovered).toBeGreaterThan(0);
    expect(detail.progress.pagesProcessed).toBeGreaterThan(0);
    expect(detail.extractedFields.some((field: { field: string }) => field.field === 'fullName' || field.field === 'title')).toBe(true);

    const contacts = await database.select().from(companyContacts).where(eq(companyContacts.companyId, companyId));
    const founder = contacts.find((contact) => contact.fullName === 'Ada Example');
    expect(founder).toBeDefined();
    expect(founder?.verificationStatus).not.toBe('VERIFIED');
    expect(contacts.every((contact) => contact.email !== 'ada.example@fixture-research.test')).toBe(true);
    const [company] = await database.select().from(companies).where(eq(companies.id, companyId));
    expect(company.description).toContain(companyName);
    expect(company.email).toBe('hello@fixture-research.test');
    expect(company.phone?.replace(/\D/g, '')).toContain('4155550199');
    expect(company.investmentStrategy?.toLowerCase()).toContain('buy houses');
    const locations = await database.select().from(companyLocations).where(eq(companyLocations.companyId, companyId));
    expect(locations).toEqual(expect.arrayContaining([expect.objectContaining({ city: 'Austin', state: 'TX', postalCode: '78701' })]));
    const evidence = await database.select().from(leadEvidence).where(eq(leadEvidence.companyId, companyId));
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.every((row) => row.sourceType && row.sourceUrl)).toBe(true);
    expect(evidence.some((row) => String(row.evidenceText).includes('Ada Example'))).toBe(true);
    const verifications = await database.select().from(leadVerifications).where(eq(leadVerifications.companyId, companyId));
    expect(verifications.length).toBeGreaterThan(0);

    await request(app.getHttpServer()).get(`/api/v1/companies/${companyId}/research/${started.body.researchExecutionId}`).set('Authorization', `Bearer ${otherToken}`).expect(404);
  }, 60000);

  async function waitForResearch(researchExecutionId: string) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await request(app.getHttpServer()).get(`/api/v1/companies/${companyId}/research/${researchExecutionId}`).set('Authorization', `Bearer ${token}`);
      if (response.status === 200 && ['COMPLETED', 'PARTIAL', 'FAILED'].includes(response.body.status)) return response.body;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Deep research did not finish');
  }
});
