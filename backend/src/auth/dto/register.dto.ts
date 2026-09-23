import { IsEmail, IsNotEmpty, IsString, MinLength, MaxLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  organizationName!: string;
}
