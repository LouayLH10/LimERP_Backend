import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';

import { QuotesService } from './quote.service';
import type { Response } from 'express';

import { CreateQuoteDto } from './dto/create-quote.dto';
import { UpdateQuoteDto } from './dto/update-quote.dto';

import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';

import { UserRole } from 'src/generated/prisma/enums';

@Controller('quotes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
export class QuoteController {
  constructor(
    private readonly quoteService: QuotesService,
  ) {}

  // --------------------------------------------------
  // Create quote
  // POST /quotes
  // --------------------------------------------------

  @Post()
  create(
    @Body() createQuoteDto: CreateQuoteDto,
  ) {
    return this.quoteService.create(
      createQuoteDto,
    );
  }

  // --------------------------------------------------
  // Get all quotes
  // GET /quotes
  // --------------------------------------------------

  @Get()
  findAll() {
    return this.quoteService.findAll();
  }

  // --------------------------------------------------
  // Get one quote
  // GET /quotes/:id
  // --------------------------------------------------

  @Get(':id')
  findOne(
    @Param('id') id: string,
  ) {
    return this.quoteService.findOne(id);
  }

  // --------------------------------------------------
  // Update quote
  // PATCH /quotes/:id
  // --------------------------------------------------

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateQuoteDto: UpdateQuoteDto,
  ) {
    return this.quoteService.update(
      id,
      updateQuoteDto,
    );
  }

  // --------------------------------------------------
  // Delete quote
  // DELETE /quotes/:id
  // --------------------------------------------------

  @Delete(':id')
  remove(
    @Param('id') id: string,
  ) {
    return this.quoteService.remove(id);
  }
  
  @Patch(':id/status')
changeStatus(
  @Param('id') id: string,
  @Body() body: { cancelled?: boolean },
) {
  return this.quoteService.changeStatus(
    id,
    body.cancelled ?? false,
  );
}
@Get(':id/pdf')
async downloadPdf(
  @Param('id') id: string,
  @Res() response: Response,
) {
  const pdf = await this.quoteService.generatePdf(id);

  response.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="devis-${id}.pdf"`,
    'Content-Length': String(pdf.length),
    'Cache-Control': 'no-store',
  });

  response.end(pdf);
}

@Post(':id/send-email')
sendEmail(@Param('id') id: string) {
  return this.quoteService.sendEmail(id);
}

}
