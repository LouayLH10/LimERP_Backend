import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateTimeSheetDto {
  @IsString()
  employeeId!: string;

  @IsDateString()
  date!: string; // format ISO "YYYY-MM-DD"

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  days?: number; // par défaut 1

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  overtimeHours?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  overtimeRate?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}