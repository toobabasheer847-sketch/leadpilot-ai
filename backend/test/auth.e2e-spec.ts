import { ValidationPipe } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import * as argon2 from 'argon2';
import request from 'supertest';
import { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { AppModule } from './../src/app.module';
import { DRIZZLE } from './../src/database/database.constants';
import type { Database } from './../src/database/database.types';
import { organizationMembers, users } from './../src/database/schema/schema';

interface AuthResponse {
  accessToken: string;
  user: {
    id: string;
    email: string;
    organization: { id: string; name: string };
    role: string;
  };
}

describe('Authentication and authorization (e2e)', () => {
  let app: INestApplication<App>;
  let database: Database;
  const password = 'StrongPassword123!';
  const unique = randomUUID().slice(0, 8);
  const ownerEmail = `owner-${unique}@example.com`;
  const memberEmail = `member-${unique}@example.com`;
  const viewerEmail = `viewer-${unique}@example.com`;
  const adminEmail = `admin-${unique}@example.com`;
  const otherOwnerEmail = `other-${unique}@example.com`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    database = app.get<Database>(DRIZZLE);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function register(email: string, organizationName: string): Promise<AuthResponse> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ name: 'Test User', email, password, organizationName })
      .expect(201);
    return response.body as AuthResponse;
  }

  async function login(email: string, loginPassword = password): Promise<AuthResponse> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: loginPassword });
    expect(response.status).toBe(201);
    return response.body as AuthResponse;
  }

  it('registers safely, authenticates, authorizes roles, and isolates organizations', async () => {
    const owner = await register(ownerEmail, `Organization ${unique}`);
    expect(owner.accessToken).toEqual(expect.any(String));
    expect(owner.user.role).toBe('OWNER');
    expect(owner.user).not.toHaveProperty('password');
    expect(owner.user).not.toHaveProperty('passwordHash');

    const storedUser = await database.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.email, ownerEmail));
    expect(storedUser[0]?.passwordHash).toMatch(/^\$argon2/);
    expect(storedUser[0]?.passwordHash).not.toBe(password);

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ name: 'Duplicate', email: ownerEmail, password, organizationName: 'Another Organization' })
      .expect(409);

    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', 'Bearer invalid').expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ownerEmail, password: 'wrong-password' })
      .expect(401)
      .expect((response) => expect(response.body.message).toBe('Invalid email or password'));

    const loggedInOwner = await login(ownerEmail);
    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${loggedInOwner.accessToken}`)
      .expect(200);
    expect(me.body).toMatchObject({
      id: owner.user.id,
      email: ownerEmail,
      role: 'OWNER',
      organization: owner.user.organization,
    });
    expect(me.body).not.toHaveProperty('passwordHash');

    const ownerAdminTest = await request(app.getHttpServer())
      .get('/api/v1/auth/admin-test')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(ownerAdminTest.body.organizationId).toBe(owner.user.organization.id);

    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const roleUsers = [
      { email: adminEmail, role: 'ADMIN' },
      { email: memberEmail, role: 'MEMBER' },
      { email: viewerEmail, role: 'VIEWER' },
    ];
    for (const roleUser of roleUsers) {
      const [user] = await database.insert(users).values({
        name: roleUser.role,
        email: roleUser.email,
        passwordHash: hash,
        status: 'ACTIVE',
      }).returning({ id: users.id });
      await database.insert(organizationMembers).values({
        organizationId: owner.user.organization.id,
        userId: user.id,
        role: roleUser.role,
      });
    }

    const admin = await login(adminEmail);
    const member = await login(memberEmail);
    const viewer = await login(viewerEmail);
    await request(app.getHttpServer()).get('/api/v1/auth/admin-test').set('Authorization', `Bearer ${admin.accessToken}`).expect(200);
    await request(app.getHttpServer()).get('/api/v1/auth/admin-test').set('Authorization', `Bearer ${member.accessToken}`).expect(403);
    await request(app.getHttpServer()).get('/api/v1/auth/admin-test').set('Authorization', `Bearer ${viewer.accessToken}`).expect(403);

    const otherOwner = await register(otherOwnerEmail, `Other Organization ${unique}`);
    const forgedOrganizationToken = app.get(JwtService).sign({
      userId: owner.user.id,
      organizationId: otherOwner.user.organization.id,
      role: 'OWNER',
    });
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${forgedOrganizationToken}`)
      .expect(401);
  });
});
