import { IsIn, IsOptional, IsString } from 'class-validator';

export class ReviewDuplicateDto {
  @IsIn(['CONFIRMED_DUPLICATE', 'NOT_DUPLICATE', 'CONFLICT'])
  decision!: 'CONFIRMED_DUPLICATE' | 'NOT_DUPLICATE' | 'CONFLICT';

  @IsOptional()
  @IsString()
  reason?: string;
}
