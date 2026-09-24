import { IsArray, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class LocationDto {
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) states?: string[];
}

class CompanySizeDto {
  @IsOptional() @IsNumber() @Min(0) min?: number;
  @IsOptional() @IsNumber() @Min(0) max?: number;
}

export class ClassifyCompanyDto {
  @IsString() category!: string;
  @IsOptional() @IsString() targetType?: string;
  @IsOptional() @ValidateNested() @Type(() => LocationDto) location?: LocationDto;
  @IsOptional() @ValidateNested() @Type(() => CompanySizeDto) companySize?: CompanySizeDto;
  @IsOptional() @IsArray() @IsString({ each: true }) requiredSignals?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) excludedSignals?: string[];
  @IsOptional() @IsString() customCriteria?: string;
}
