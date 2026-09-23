import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class PreviewSearchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  prompt!: string;
}
