import { IsBoolean, IsOptional } from 'class-validator';

export class VerifyLeadDto {
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
