import { IsBoolean, IsOptional } from 'class-validator';

export class CalculateScoreDto {
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
