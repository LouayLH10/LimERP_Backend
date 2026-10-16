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
import type { Response } from 'express';

import { InvoiceService } from './invoice.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';

import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { UserRole } from 'src/generated/prisma/enums';

@Controller('invoices')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
export class InvoiceController {
  constructor(
    private readonly invoiceService: InvoiceService,
  ) {}

  // ============================================================
  // CREATE INVOICE FROM DELIVERY
  // ============================================================

  @Post('from-delivery/:deliveryId')
  create(
    @Param('deliveryId') deliveryId: string,
    @Body() createInvoiceDto: CreateInvoiceDto,
  ) {
    return this.invoiceService.create(
      deliveryId,
      createInvoiceDto,
    );
  }

  // ============================================================
  // GET ALL INVOICES
  // ============================================================

  @Get()
  findAll() {
    return this.invoiceService.findAll();
  }

  // ============================================================
  // GET ONE INVOICE
  // ============================================================

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.invoiceService.findOne(id);
  }

  // ============================================================
  // UPDATE INVOICE
  // ============================================================

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateInvoiceDto: UpdateInvoiceDto,
  ) {
    return this.invoiceService.update(
      id,
      updateInvoiceDto,
    );
  }

  // ============================================================
  // CHANGE STATUS
  // ============================================================

  @Patch(':id/status')
  changeStatus(
    @Param('id') id: string,
    @Body() body: { cancelled?: boolean },
  ) {
    return this.invoiceService.changeStatus(
      id,
      body.cancelled ?? false,
    );
  }

  // ============================================================
  // DELETE INVOICE
  // ============================================================

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.invoiceService.remove(id);
  }
  @Get(':id/pdf')
async downloadPdf(
  @Param('id') id: string,
  @Res() res: Response,
) {
  const pdf = await this.invoiceService.generatePdf(id);

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="facture-${id}.pdf"`,
    'Content-Length': pdf.length,
  });

  res.end(pdf);
}

// ============================================================
// SEND INVOICE BY EMAIL
// ============================================================

@Post(':id/send-email')
sendEmail(@Param('id') id: string) {
  return this.invoiceService.sendEmail(id);
}
// ============================================================
// REGISTER PAYMENT
// ============================================================

@Patch(':id/payment')
registerPayment(
  @Param('id') id: string,
  @Body() body: { amount: number },
) {
  return this.invoiceService.registerPayment(id, body.amount);
}
// ============================================================
// GENERATE RECEIPT PDF
// ============================================================

@Get(':id/receipt/pdf')
async downloadReceiptPdf(
  @Param('id') id: string,
  @Res() res: Response,
) {
  const pdf = await this.invoiceService.generateReceiptPdf(id);

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="recu-${id}.pdf"`,
    'Content-Length': pdf.length,
  });

  res.end(pdf);
}

// ============================================================
// SEND RECEIPT BY EMAIL
// ============================================================

@Post(':id/receipt/send-email')
sendReceiptEmail(@Param('id') id: string) {
  return this.invoiceService.sendReceiptEmail(id);
}
}
