import { Module } from '@nestjs/common';
import { QuotesService } from './quote.service';
import { QuoteController } from './quote.controller';

@Module({
  controllers: [QuoteController],
  providers: [QuotesService],
})
export class QuoteModule {}
