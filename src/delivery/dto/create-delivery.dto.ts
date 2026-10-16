import {
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

import { Type } from 'class-transformer';

export class CreateDeliveryLineDto {
  @IsString()
  @IsNotEmpty()
  description: string;

  @IsNumber()
  @Min(0.001)
  quantity: number;
}

export class CreateDeliveryDto {
     @IsUUID()
    @IsNotEmpty()
    clientId: string;   
    @IsUUID()
    @IsOptional()
    projectId?: string;

  @IsUUID()
  @IsNotEmpty()
  orderId: string;
   @IsDateString()
      @IsOptional()
deliveryDate:string;
  @IsOptional()
  @IsString()
  notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateDeliveryLineDto)
  lines: CreateDeliveryLineDto[];
}
