import {
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateOrderFromQuoteLineDto {
  @IsString()
  @IsNotEmpty()
  description: string;

  @IsNumber()
  @Min(0.001)
  quantity: number;

  @IsNumber()
  @Min(0)
  unitPrice: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  taxRate: number;
}

export class CreateOrderFromQuoteDto {
    @IsUUID()
    @IsNotEmpty()
    clientId: string;
  
    @IsUUID()
    @IsOptional()
    projectId?: string;
  
    @IsDateString()
    @IsOptional()
    orderDate?: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderFromQuoteLineDto)
  lines: CreateOrderFromQuoteLineDto[];

  @IsString()
  @IsOptional()
  notes?: string;
}