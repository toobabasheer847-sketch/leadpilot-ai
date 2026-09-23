import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/schema';
import { DatabaseService } from './database.service';
import { DRIZZLE } from './database.constants';

@Global()
@Module({
  providers: [
    DatabaseService,
    {
      provide: DRIZZLE,
      useFactory: (configService: ConfigService) => {
        const connectionString = configService.get<string>('database.url');
        const pool = new Pool({ connectionString });
        return drizzle(pool, { schema });
      },
      inject: [ConfigService],
    },
  ],
  exports: [DRIZZLE, DatabaseService],
})
export class DatabaseModule {}

export { DRIZZLE } from './database.constants';