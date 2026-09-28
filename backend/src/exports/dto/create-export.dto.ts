import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
import { EXPORT_FIELDS, EXPORT_MODES, MISSING_VALUE_MODES, type ExportField, type ExportFormat, type ExportMode, type MissingValueMode } from '../types/export.types';
import { ListLeadsDto } from '../../leads/dto/list-leads.dto';

export class CreateExportDto {
  @IsIn(['csv', 'xlsx'])
  format!: ExportFormat;

  @IsOptional()
  @IsIn(EXPORT_MODES)
  exportMode?: ExportMode;

  @IsOptional()
  @IsIn(MISSING_VALUE_MODES)
  missingValueMode?: MissingValueMode;

  @IsOptional()
  @ValidateNested()
  @Type(() => ListLeadsDto)
  filters?: ListLeadsDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsIn(EXPORT_FIELDS, { each: true })
  fields?: ExportField[];
}
