import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateSearchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  prompt!: string;
}
