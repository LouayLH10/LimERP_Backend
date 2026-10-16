import { Module } from '@nestjs/common';
import { DocumentTemplateService } from './document-template.service';
import { DocumentTemplateController } from './document-template.controller';

@Module({
  controllers: [DocumentTemplateController],
  providers: [DocumentTemplateService],
})
export class DocumentTemplateModule {}
