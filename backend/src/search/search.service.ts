import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { Database } from '../database/database.types';
import { auditLogs, pipelineJobs, searchExecutions } from '../database/schema/schema';
import { AuthenticatedUser } from '../auth/auth.types';
import { CreateSearchDto } from './dto/create-search.dto';
import { UpdateSearchDto } from './dto/update-search.dto';
import { ListSearchesDto } from './dto/list-searches.dto';
import { SearchPlanParser } from './parsers/search-plan.parser';
import { SearchConfigurationRepository } from './repositories/search-configuration.repository';
import { SearchExecutionRepository } from './repositories/search-execution.repository';
import { SourceDiscoveryQueue } from '../sources/source-discovery.queue';
import { SourceDiscoveryService } from '../sources/services/source-discovery.service';

@Injectable()
export class SearchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly parser: SearchPlanParser,
    private readonly configurations: SearchConfigurationRepository,
    private readonly executions: SearchExecutionRepository,
    private readonly sourceQueue: SourceDiscoveryQueue,
    private readonly discovery: SourceDiscoveryService,
  ) {}

  preview(prompt: string) {
    const structuredPlan = this.parser.parse(prompt);
    return { originalPrompt: prompt, structuredPlan };
  }

  async create(user: AuthenticatedUser, dto: CreateSearchDto) {
    const structuredPlan = this.parser.parse(dto.prompt);
    const search = await this.configurations.create({
      organizationId: user.organizationId,
      createdByUserId: user.id,
      name: dto.name.trim(),
      originalPrompt: dto.prompt.trim(),
      criteria: structuredPlan,
      status: 'ACTIVE',
    });
    await this.writeAudit(user, 'SEARCH_CREATED', search.id, { name: search.name });
    return search;
  }

  async list(user: AuthenticatedUser, pagination: ListSearchesDto) {
    return this.configurations.listForOrganization(user.organizationId, pagination.page, pagination.limit);
  }

  async findOne(user: AuthenticatedUser, searchId: string) {
    const search = await this.configurations.findByIdForOrganization(searchId, user.organizationId);
    if (!search) {
      throw new NotFoundException('Search not found');
    }
    return search;
  }

  async update(user: AuthenticatedUser, searchId: string, dto: UpdateSearchDto) {
    await this.findOne(user, searchId);
    const data = {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.prompt !== undefined ? {
        originalPrompt: dto.prompt.trim(),
        criteria: this.parser.parse(dto.prompt),
      } : {}),
    };
    const search = await this.configurations.updateForOrganization(searchId, user.organizationId, data);
    if (!search) {
      throw new NotFoundException('Search not found');
    }
    await this.writeAudit(user, 'SEARCH_UPDATED', search.id, {
      changedName: String(dto.name !== undefined),
      changedPrompt: String(dto.prompt !== undefined),
    });
    return search;
  }

  async createExecution(user: AuthenticatedUser, searchId: string) {
    const search = await this.findOne(user, searchId);
    const existing = await this.db.select().from(searchExecutions).where(and(
      eq(searchExecutions.searchConfigurationId, searchId),
      eq(searchExecutions.organizationId, user.organizationId),
      inArray(searchExecutions.status, ['QUEUED', 'RUNNING']),
    )).orderBy(desc(searchExecutions.createdAt)).limit(1);
    if (existing[0]) {
      return existing[0];
    }

    const execution = await this.db.transaction(async (tx) => {
      const [created] = await tx.insert(searchExecutions).values({
        searchConfigurationId: search.id,
        organizationId: user.organizationId,
        status: 'QUEUED',
        structuredPlan: search.criteria,
      }).returning();

      await tx.insert(pipelineJobs).values({
        searchExecutionId: created.id,
        jobType: 'SEARCH_DISCOVERY',
        status: 'QUEUED',
        bullJobId: `search-discovery-${created.id}`,
      });
      return created;
    });

    try {
      await this.sourceQueue.enqueue({
        searchExecutionId: execution.id,
        searchConfigurationId: search.id,
        organizationId: user.organizationId,
      });
    } catch {
      await this.db.update(searchExecutions).set({
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: 'Source discovery job could not be queued.',
        updatedAt: new Date(),
      }).where(eq(searchExecutions.id, execution.id));
      throw new ServiceUnavailableException('Source discovery is temporarily unavailable.');
    }
    await this.writeAudit(user, 'SEARCH_EXECUTION_CREATED', execution.id, { searchId });
    return execution;
  }

  async listExecutions(user: AuthenticatedUser, searchId: string) {
    await this.findOne(user, searchId);
    return this.executions.listForSearch(searchId, user.organizationId);
  }

  async getExecution(user: AuthenticatedUser, executionId: string) {
    const execution = await this.executions.findByIdForOrganization(executionId, user.organizationId);
    if (!execution) {
      throw new NotFoundException('Search execution not found');
    }
    return execution;
  }

  async listCandidates(user: AuthenticatedUser, executionId: string, page: number, limit: number) {
    const execution = await this.getExecution(user, executionId);
    return this.discovery.listCandidates(execution.id, user.organizationId, page, limit);
  }

  private async writeAudit(user: AuthenticatedUser, action: string, entityId: string, metadata: Record<string, string>) {
    await this.db.insert(auditLogs).values({
      organizationId: user.organizationId,
      userId: user.id,
      action,
      entityType: 'search',
      entityId,
      metadata,
    });
  }
}
