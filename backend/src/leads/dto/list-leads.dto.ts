import { Transform, Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, Min, IsUUID } from 'class-validator';

const toBoolean = ({ value }: { value: unknown }) => value === true || value === 'true' ? true : value === false || value === 'false' ? false : value;

export class ListLeadsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 25;
  @IsOptional() @IsIn(['score', 'companyName', 'createdAt', 'updatedAt', 'lastVerifiedAt']) sortBy = 'createdAt';
  @IsOptional() @IsIn(['asc', 'desc']) sortOrder: 'asc' | 'desc' = 'desc';
  @IsOptional() @IsUUID() organizationId?: string;
  @IsOptional() @IsUUID() searchExecutionId?: string;
  @IsOptional() @IsIn(['QUALIFIED', 'NOT_QUALIFIED', 'NEEDS_REVIEW']) qualificationStatus?: string;
  @IsOptional() @IsIn(['QUALIFIED', 'NOT_QUALIFIED', 'INSUFFICIENT_EVIDENCE']) classification?: string;
  @IsOptional() @Type(() => Number) @Min(0) @Max(1) classificationConfidence?: number;
  @IsOptional() @Type(() => Number) @Min(0) @Max(100) minScore?: number;
  @IsOptional() @Type(() => Number) @Min(0) @Max(100) maxScore?: number;
  @IsOptional() @IsIn(['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH']) scoreBand?: string;
  @IsOptional() @IsIn(['VERIFIED', 'SUPPORTED', 'UNVERIFIED', 'NOT_FOUND', 'CONFLICT', 'NEEDS_REVIEW', 'INVALID', 'PARTIALLY_VERIFIED']) verificationStatus?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() companyName?: string;
  @IsOptional() @IsString() website?: string;
  @IsOptional() @IsString() domain?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() zipCode?: string;
  @IsOptional() @IsString() investorType?: string;
  @IsOptional() @IsString() investmentStrategy?: string;
  @IsOptional() @IsString() propertyType?: string;
  @IsOptional() @IsString() marketServed?: string;
  @IsOptional() @IsString() companySize?: string;
  @IsOptional() @IsString() contactTitle?: string;
  @IsOptional() @Transform(toBoolean) hasDecisionMaker?: boolean;
  @IsOptional() @Transform(toBoolean) hasEmail?: boolean;
  @IsOptional() @Transform(toBoolean) hasPhone?: boolean;
  @IsOptional() @Transform(toBoolean) hasLinkedIn?: boolean;
  @IsOptional() @Transform(toBoolean) hasFacebook?: boolean;
  @IsOptional() @Transform(toBoolean) hasInstagram?: boolean;
  @IsOptional() @IsString() duplicateStatus?: string;
  @IsOptional() @IsDateString() createdFrom?: string;
  @IsOptional() @IsDateString() createdTo?: string;
  @IsOptional() @IsDateString() lastVerifiedFrom?: string;
  @IsOptional() @IsDateString() lastVerifiedTo?: string;
}
