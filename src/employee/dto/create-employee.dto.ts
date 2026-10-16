import { IsEmail, IsEnum, IsOptional, IsString } from 'class-validator';
import { EmployeePosition } from '../../generated/prisma/enums';

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

  @IsOptional()
  @IsString()
  cinNumber?: string;
}