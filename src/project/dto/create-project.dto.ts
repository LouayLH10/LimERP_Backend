import {
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ArrayUnique,
  IsNumber,
  IsIn,
  Min,
  Max,
} from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  daNumber?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsUUID()
  clientId: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  employeeIds?: string[];

  // ========================================================
  // NOUVEAUX CHAMPS POUR LE CHIFFRAGE
  // ========================================================

  @IsOptional()
  @IsString()
  @IsIn(['client', 'entreprise'], {
    message: "consommablesResponsible doit être 'client' ou 'entreprise'",
  })
  consommablesResponsible?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  manutentionPercentage?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  durationDays?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  employeeDailyRate?: number;
}