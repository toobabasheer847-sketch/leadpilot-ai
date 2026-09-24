import { ValidationPipe } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { AppModule } from './../src/app.module';

interface AuthResponse {
  accessToken: string;
  user: { organization: { id: string } };
}

describe('Search configuration and execution (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let otherToken: string;
  let searchId: string;
  const password = 'StrongPassword123!';
  const unique = randomUUID().slice(0, 8);
  const prompt = 'Find real estate companies in Texas that are cash home buyers with 1-50 employees and provide website, LinkedIn, Facebook and Instagram. I need the CEO, founder or president with email.';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    const owner = await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      name: 'Search Owner', email: `search-owner-${unique}@example.com`, password, organizationName: `Search Org ${unique}`,
    }).expect(201);
    token = (owner.body as AuthResponse).accessToken;

    const other = await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      name: 'Other Owner', email: `search-other-${unique}@example.com`, password, organizationName: `Other Org ${unique}`,
    }).expect(201);
    otherToken = (other.body as AuthResponse).accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('previews a plan and rejects invalid preview input', async () => {
    const preview = await request(app.getHttpServer()).post('/api/v1/searches/preview').set('Authorization', `Bearer ${token}`).send({ prompt });
    expect(preview.status).toBe(201);
    expect(preview.body.structuredPlan).toMatchObject({
      industry: ['real_estate'],
      leadTypes: ['cash_home_buyer'],
      locations: [{ country: 'US', state: 'Texas' }],
      companySize: { min: 1, max: 50 },
    });
    expect(preview.body).not.toHaveProperty('searchId');

    await request(app.getHttpServer()).post('/api/v1/searches/preview').set('Authorization', `Bearer ${token}`).send({ prompt: '' }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/searches/preview').set('Authorization', `Bearer ${token}`).send({ prompt, unknown: true }).expect(400);
  });

  it('creates, lists, updates, executes, and scopes searches by organization', async () => {
    const created = await request(app.getHttpServer()).post('/api/v1/searches').set('Authorization', `Bearer ${token}`).send({ name: 'Texas Search', prompt }).expect(201);
    searchId = created.body.id;
    expect(created.body.criteria).toMatchObject({ locations: [{ state: 'Texas' }] });

    const list = await request(app.getHttpServer()).get('/api/v1/searches?page=1&limit=20').set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.items.some((item: { id: string }) => item.id === searchId)).toBe(true);

    await request(app.getHttpServer()).get(`/api/v1/searches/${searchId}`).set('Authorization', `Bearer ${otherToken}`).expect(404);
    await request(app.getHttpServer()).patch(`/api/v1/searches/${searchId}`).set('Authorization', `Bearer ${otherToken}`).send({ name: 'Hijack' }).expect(404);

    const updatedPrompt = 'Find software companies in California with 51-200 employees.';
    await request(app.getHttpServer()).patch(`/api/v1/searches/${searchId}`).set('Authorization', `Bearer ${token}`).send({ prompt: updatedPrompt }).expect(200);
    const execution = await request(app.getHttpServer()).post(`/api/v1/searches/${searchId}/execute`).set('Authorization', `Bearer ${token}`).expect(201);
    expect(execution.body.status).toBe('QUEUED');
    expect(execution.body.structuredPlan).toMatchObject({
      industry: ['software'],
      locations: [{ state: 'California' }],
      companySize: { min: 51, max: 200 },
    });

    const duplicate = await request(app.getHttpServer()).post(`/api/v1/searches/${searchId}/execute`).set('Authorization', `Bearer ${token}`).expect(201);
    const current = await request(app.getHttpServer()).get(`/api/v1/searches/executions/${execution.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    if (['QUEUED', 'RUNNING'].includes(current.body.status)) {
      expect(duplicate.body.id).toBe(execution.body.id);
    }

    await request(app.getHttpServer()).get(`/api/v1/searches/${searchId}/executions`).set('Authorization', `Bearer ${token}`).expect(200).expect((response) => {
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body[0].structuredPlan).toMatchObject({ industry: ['software'] });
    });
    await request(app.getHttpServer()).get(`/api/v1/searches/executions/${execution.body.id}`).set('Authorization', `Bearer ${otherToken}`).expect(404);
  });
});
