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

import { DeliveryService } from './delivery.service';

import { CreateDeliveryDto } from './dto/create-delivery.dto';
import { UpdateDeliveryDto } from './dto/update-delivery.dto';

import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';

import { UserRole } from 'src/generated/prisma/enums';
import type { Response } from 'express';
@Controller('deliveries')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
export class DeliveryController {
  constructor(
    private readonly deliveryService: DeliveryService,
  ) {}

  // =======================================================
  // CREATE DELIVERY
  // POST /deliveries
  // =======================================================

 @Post('from-order/:orderId')
create(
  @Param('orderId') orderId: string,
  @Body() createDeliveryDto: CreateDeliveryDto,
) {
  return this.deliveryService.create(
    orderId,
    createDeliveryDto,
  );
}

  // =======================================================
  // FIND ALL DELIVERIES
  // GET /deliveries
  // =======================================================

  @Get()
  findAll() {
    return this.deliveryService.findAll();
  }

  // =======================================================
  // FIND ONE DELIVERY
  // GET /deliveries/:id
  // =======================================================

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.deliveryService.findOne(id);
  }

  // =======================================================
  // UPDATE DELIVERY
  // PATCH /deliveries/:id
  // =======================================================

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateDeliveryDto: UpdateDeliveryDto,
  ) {
    return this.deliveryService.update(
      id,
      updateDeliveryDto,
    );
  }

  // =======================================================
  // CONFIRM DELIVERY
  // PATCH /deliveries/:id/confirm
  // =======================================================

  @Patch(':id/confirm')
  confirm(@Param('id') id: string) {
    return this.deliveryService.confirm(id);
  }

  // =======================================================
  // DELETE DELIVERY
  // DELETE /deliveries/:id
  // =======================================================

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.deliveryService.remove(id);
  }

  @Patch(':id/status')
changeStatus(
  @Param('id') id: string,
  @Body() body: { cancelled?: boolean },
) {
  return this.deliveryService.changeStatus(
    id,
    body.cancelled ?? false,
  );
}
@Get(':id/pdf')
async downloadPdf(
  @Param('id') id: string,
  @Res() res: Response,
) {
  const pdf = await this.deliveryService.generatePdf(id);

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="bon-livraison-${id}.pdf"`,
    'Content-Length': pdf.length,
  });

  res.end(pdf);
}

@Post(':id/send-email')
sendEmail(@Param('id') id: string) {
  return this.deliveryService.sendEmail(id);
}
}
