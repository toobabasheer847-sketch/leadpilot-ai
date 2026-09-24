import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
import { EXPORT_FIELDS, type ExportField, type ExportFormat } from '../types/export.types';
import { ListLeadsDto } from '../../leads/dto/list-leads.dto';

export class CreateExportDto {
  @IsIn(['csv', 'xlsx'])
  format!: ExportFormat;

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
