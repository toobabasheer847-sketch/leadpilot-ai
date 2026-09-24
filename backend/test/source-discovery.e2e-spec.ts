import { ValidationPipe } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';

process.env.SOURCE_PROVIDER = 'fake';

describe('Source discovery pipeline (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let searchId: string;
  const unique = randomUUID().slice(0, 8);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [await import('../src/app.module').then((module) => module.AppModule)] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    const registration = await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      name: 'Source Test User',
      email: `source-${unique}@example.com`,
      password: 'StrongPassword123!',
      organizationName: `Source Test Organization ${unique}`,
    }).expect(201);
    token = registration.body.accessToken;
    const search = await request(app.getHttpServer()).post('/api/v1/searches').set('Authorization', `Bearer ${token}`).send({
      name: 'Synthetic Source Search',
      prompt: 'Find real estate companies in Texas',
    }).expect(201);
    searchId = search.body.id;
  }, 60000);

  afterAll(async () => {
    await app.close();
  });

  it('runs a fake provider through BullMQ and persists provenance candidates', async () => {
    const executionResponse = await request(app.getHttpServer()).post(`/api/v1/searches/${searchId}/execute`).set('Authorization', `Bearer ${token}`).expect(201);
    const executionId = executionResponse.body.executionId as string;
    let execution;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await request(app.getHttpServer()).get(`/api/v1/searches/executions/${executionId}`).set('Authorization', `Bearer ${token}`).expect(200);
      execution = response.body;
      if (execution.status === 'COMPLETED' || execution.status === 'FAILED') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(execution.status).toBe('COMPLETED');
    expect(execution.totalCandidates).toBe(1);
    expect(execution.errorMessage).toBeNull();

    const candidates = await request(app.getHttpServer()).get(`/api/v1/searches/executions/${executionId}/candidates?page=1&limit=20`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(candidates.body.total).toBe(1);
    expect(candidates.body.items[0]).toMatchObject({
      company: { name: 'Synthetic Example Business', website: 'https://example.test' },
      source: { sourceType: 'fake_source', externalId: 'test-place-001' },
      location: { state: 'Texas', country: 'US' },
    });

    const duplicateExecution = await request(app.getHttpServer()).post(`/api/v1/searches/${searchId}/execute`).set('Authorization', `Bearer ${token}`).expect(201);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await request(app.getHttpServer()).get(`/api/v1/searches/executions/${duplicateExecution.body.executionId}`).set('Authorization', `Bearer ${token}`).expect(200);
      if (response.body.status === 'COMPLETED' || response.body.status === 'FAILED') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const duplicateCandidates = await request(app.getHttpServer()).get(`/api/v1/searches/executions/${duplicateExecution.body.executionId}/candidates`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(duplicateCandidates.body.total).toBe(1);
  });
});
