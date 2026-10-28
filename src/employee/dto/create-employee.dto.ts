import { 
  IsEmail, 
  IsEnum, 
  IsNumber, 
  IsOptional, 
  IsString, 
  Min,
  Length 
} from 'class-validator';
import { EmployeePosition } from '../../generated/prisma/enums';
import { Type } from 'class-transformer';

export class CreateEmployeeDto {
  @IsString()
  firstName: string;

  @IsString()
  lastName: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsEnum(EmployeePosition)
  position: EmployeePosition;

  // 👇 NOUVEAU CHAMP : Numéro CNSS
  @IsOptional()
  @IsString()
  cnssNumber?: string;

  @IsOptional()
  @IsString()
  @Length(8, 8, { message: 'Le numéro CIN doit contenir exactement 8 chiffres.' })
  cinNumber?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  dailyRate?: number;
}