import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
  Res
} from '@nestjs/common';

import { OrderService } from './order.service';
import type { Response } from 'express';
import { CreateOrderFromQuoteDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';

import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';

import { UserRole } from 'src/generated/prisma/enums';

@Controller('orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
  ) {}

  // =======================================================
  // CREATE ORDER FROM QUOTE
  // POST /orders/from-quote/:quoteId
  // =======================================================

  @Post('from-quote/:quoteId')
  createFromQuote(
    @Param('quoteId') quoteId: string,
    @Body() createOrderDto: CreateOrderFromQuoteDto,
  ) {
    return this.orderService.createFromQuote(
      quoteId,
      createOrderDto,
    );
  }

  // =======================================================
  // FIND ALL ORDERS
  // GET /orders
  // =======================================================

  @Get()
  findAll() {
    return this.orderService.findAll();
  }

  // =======================================================
  // FIND ONE ORDER
  // GET /orders/:id
  // =======================================================

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.orderService.findOne(id);
  }

  // =======================================================
  // UPDATE ORDER
  // PATCH /orders/:id
  // =======================================================

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateOrderDto: UpdateOrderDto,
  ) {
    return this.orderService.update(
      id,
      updateOrderDto,
    );
  }

  // =======================================================
  // CONFIRM ORDER
  // PATCH /orders/:id/confirm
  // =======================================================

  @Patch(':id/confirm')
  confirm(@Param('id') id: string) {
    return this.orderService.confirm(id);
  }

  // =======================================================
  // DELETE ORDER
  // DELETE /orders/:id
  // =======================================================

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.orderService.remove(id);
  }

  @Patch(':id/status')
changeStatus(
  @Param('id') id: string,
  @Body() body: { cancelled?: boolean },
) {
  return this.orderService.changeStatus(
    id,
    body.cancelled ?? false,
  );
}
@Get(':id/pdf')
async generatePdf(@Param('id') id: string, @Res() res: Response) {
  const pdf = await this.orderService.generatePdf(id);

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="commande-${id}.pdf"`,
  });

  res.end(pdf);
}

@Post(':id/send-email')
sendEmail(@Param('id') id: string) {
  return this.orderService.sendEmail(id);
}
}
