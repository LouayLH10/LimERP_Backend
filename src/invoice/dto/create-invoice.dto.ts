import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class CreateInvoiceDto {
    @IsUUID()
    @IsNotEmpty()
    clientId: string;
  
    @IsUUID()
    @IsOptional()
    projectId?: string;
  @IsDateString()
  @IsOptional()
  dueDate?: string;

  @IsString()
  @IsOptional()
  notes?: string;
}
export class CreateInvoiceLineDto { 
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
      taxRate: number; }
