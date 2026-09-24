import { IsUUID } from 'class-validator';

export class MergeDuplicateDto {
  @IsUUID()
  canonicalEntityId!: string;
}
