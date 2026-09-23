import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchPlanParser } from './parsers/search-plan.parser';
import { SearchConfigurationRepository } from './repositories/search-configuration.repository';
import { SearchExecutionRepository } from './repositories/search-execution.repository';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SourcesModule } from '../sources/sources.module';

@Module({
  imports: [AuthModule, UsersModule, OrganizationsModule, SourcesModule],
  controllers: [SearchController],
  providers: [SearchService, SearchPlanParser, SearchConfigurationRepository, SearchExecutionRepository],
})
export class SearchModule {}
