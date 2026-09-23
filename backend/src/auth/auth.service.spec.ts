import { ConflictException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  it('propagates membership failure so the transaction can roll back registration', async () => {
    const organization = {
      id: 'org-id',
      name: 'Test Organization',
      slug: 'test-organization',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const user = {
      id: 'user-id',
      name: 'Test User',
      email: 'test@example.com',
      passwordHash: await argon2.hash('StrongPassword123!'),
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
      insert: jest.fn()
        .mockImplementationOnce(() => ({ values: () => ({ returning: async () => [organization] }) }))
        .mockImplementationOnce(() => ({ values: () => ({ returning: async () => [user] }) }))
        .mockImplementationOnce(() => ({ values: async () => { throw new Error('membership insert failed'); } })),
    }));
    const database = { transaction };
    const usersService = {};
    const organizationsService = {};
    const jwtService = {};
    const service = new AuthService(
      database as never,
      usersService as never,
      organizationsService as never,
      jwtService as never,
    );

    await expect(service.register({
      name: 'Test User',
      email: 'test@example.com',
      password: 'StrongPassword123!',
      organizationName: 'Test Organization',
    })).rejects.toThrow('membership insert failed');
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('does not convert duplicate-email conflicts into a successful registration', async () => {
    const database = {
      transaction: jest.fn().mockRejectedValue(new ConflictException('Email is already registered')),
    };
    const service = new AuthService(
      database as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.register({
      name: 'Test User',
      email: 'duplicate@example.com',
      password: 'StrongPassword123!',
      organizationName: 'Test Organization',
    })).rejects.toBeInstanceOf(ConflictException);
  });
});
