import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsageService } from './usage.service';
import type { UsageOperation, UsageRecordInput } from './types/usage.types';

@Injectable()
export class ProviderUsageService {
  constructor(
    private readonly usage: UsageService,
    private readonly config: ConfigService,
  ) {}

  recordUsage(input: UsageRecordInput) {
    return this.usage.recordUsage(input);
  }

  checkQuota(organizationId: string, operation: UsageOperation, requestedUnits = 1) {
    return this.usage.assertDailyQuota(organizationId, operation, requestedUnits);
  }

  getUsage(organizationId: string, operation: UsageOperation, since: Date) {
    return this.usage.getUsage(organizationId, operation, since);
  }

  estimateCost(provider: string, units: number, metadata?: Record<string, unknown>) {
    const pricing = this.config.get<Record<string, unknown>>('usage.pricing', {});
    const providerPricing = pricing[provider];
    if (typeof providerPricing !== 'object' || providerPricing === null) return { cost: null, status: 'UNKNOWN' as const };
    const unitCost = Number((providerPricing as Record<string, unknown>).unitCost);
    if (!Number.isFinite(unitCost) || unitCost < 0) return { cost: null, status: 'UNKNOWN' as const };
    const multiplier = Number(metadata?.unitsMultiplier ?? 1);
    if (!Number.isFinite(multiplier) || multiplier < 0) return { cost: null, status: 'UNKNOWN' as const };
    return { cost: unitCost * units * multiplier, status: 'ESTIMATED' as const };
  }
}