import { IsBoolean, IsOptional } from 'class-validator';

export class QualifyExecutionDto {
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
