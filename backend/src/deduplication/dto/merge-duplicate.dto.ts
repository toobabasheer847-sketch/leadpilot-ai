import { IsOptional, IsUUID } from 'class-validator';

export class MergeDuplicateDto {
  @IsOptional()
  @IsUUID()
  canonicalEntityId?: string;
}
