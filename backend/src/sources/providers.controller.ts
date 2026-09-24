import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DiscoveryProviderRegistry } from './providers/discovery-provider.registry';

@Controller('providers')
@UseGuards(JwtAuthGuard)
export class ProvidersController {
  constructor(private readonly providers: DiscoveryProviderRegistry) {}

  @Get()
  list() {
    return this.providers.status();
  }
}
