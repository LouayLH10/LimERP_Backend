import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

export class CreateClientDto {
  @IsString()
  @IsNotEmpty()
  @Length(2, 150)
  companyName: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  @Length(6, 30)
  phone?: string;

  @IsString()
  @IsOptional()
  @Length(2, 255)
  address?: string;

  @IsString()
  @IsOptional()
  @Length(2, 100)
  city?: string;

  @IsString()
  @IsOptional()
  @Length(2, 100)
  country?: string;

 
}
