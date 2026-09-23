import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateSearchDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  prompt?: string;
}
