import { IsEmail, IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';
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

  @IsOptional()
  @IsString()
  cinNumber?: string;
    @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  dailyRate?: number;
}