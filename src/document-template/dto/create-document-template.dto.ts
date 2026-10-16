
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { DocumentType } from 'src/generated/prisma/enums';

export class CreateDocumentTemplateDto {
  @IsString()
  @IsNotEmpty()
  @Length(2, 100)
  name: string;

  @IsEnum(DocumentType)
  type: DocumentType;

  @IsString()
  @IsOptional()
  description?: string;

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}




export class UpdateDocumentTemplateDto {
  @IsString()
  @IsOptional()
  @Length(2, 100)
  name?: string;

  @IsEnum(DocumentType)
  @IsOptional()
  type?: DocumentType;

  @IsString()
  @IsOptional()
  description?: string;

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}




export class UpdateTemplateStyleDto {
  @IsString()
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/)
  primaryColor?: string;

  @IsString()
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/)
  secondaryColor?: string;

  @IsString()
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/)
  accentColor?: string;

  @IsString()
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/)
  textColor?: string;

  @IsString()
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/)
  backgroundColor?: string;

  @IsString()
  @IsOptional()
  fontFamily?: string;

  @IsInt()
  @IsOptional()
  @Min(6)
  @Max(32)
  fontSize?: number;

  @IsInt()
  @IsOptional()
  @Min(0)
  @Max(50)
  borderRadius?: number;

  @IsInt()
  @IsOptional()
  @Min(0)
  @Max(50)
  spacing?: number;

  @IsBoolean()
  @IsOptional()
  showLogo?: boolean;

  @IsBoolean()
  @IsOptional()
  showFooter?: boolean;

  @IsBoolean()
  @IsOptional()
  showSignature?: boolean;
}
