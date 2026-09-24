import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListExecutionsDto } from './dto/list-executions.dto';
import { ListLeadsDto } from './dto/list-leads.dto';

describe('lead API contracts', () => {
  it('accepts defaults and valid score pagination filters', async () => {
    const dto = plainToInstance(ListLeadsDto, { page: '2', limit: '100', minScore: '70', maxScore: '90', scoreBand: 'HIGH', sortBy: 'score', sortOrder: 'asc' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.page).toBe(2);
    expect(dto.limit).toBe(100);
  });

  it('rejects invalid pages, limits, scores, enums, and sort fields', async () => {
    const dto = plainToInstance(ListLeadsDto, { page: '0', limit: '101', minScore: '101', sortBy: 'password', classification: 'MAYBE' });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });

  it('rejects malformed execution dates and unsupported statuses', async () => {
    const dto = plainToInstance(ListExecutionsDto, { createdFrom: 'yesterday', status: 'UNKNOWN' });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });

  it('does not manufacture missing lead values in the DTO layer', () => {
    const dto = plainToInstance(ListLeadsDto, {});
    expect(dto.companyName).toBeUndefined();
    expect(dto.hasEmail).toBeUndefined();
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(25);
  });
});
