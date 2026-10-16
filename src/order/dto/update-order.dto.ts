import { PartialType } from '@nestjs/mapped-types';
import { CreateOrderFromQuoteDto } from './create-order.dto'; 

export class UpdateOrderDto extends PartialType(CreateOrderFromQuoteDto) {}
