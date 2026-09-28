import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchPlanParser } from './parsers/search-plan.parser';
import { SearchPlanPlanner } from './parsers/search-plan-planner';
import { ClassificationModule } from '../ai/classification/classification.module';
import { SearchConfigurationRepository } from './repositories/search-configuration.repository';
import { SearchExecutionRepository } from './repositories/search-execution.repository';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SourcesModule } from '../sources/sources.module';
import { UsageModule } from '../usage/usage.module';

@Module({
  imports: [AuthModule, UsersModule, OrganizationsModule, SourcesModule, UsageModule, ClassificationModule],
  controllers: [SearchController],
  providers: [SearchService, SearchPlanParser, SearchPlanPlanner, SearchConfigurationRepository, SearchExecutionRepository],
  exports: [SearchService],
})
export class SearchModule {}
