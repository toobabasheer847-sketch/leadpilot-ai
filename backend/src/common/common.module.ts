import { Global, Module } from '@nestjs/common';
import { OutboundRequestService } from './outbound-request.service';

@Global()
@Module({
  providers: [OutboundRequestService],
  exports: [OutboundRequestService],
})
export class CommonModule {}
