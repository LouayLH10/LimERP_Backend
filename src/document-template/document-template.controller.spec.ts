import { Test, TestingModule } from '@nestjs/testing';
import { DocumentTemplateController } from './document-template.controller';
import { DocumentTemplateService } from './document-template.service';

describe('DocumentTemplateController', () => {
  let controller: DocumentTemplateController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DocumentTemplateController],
      providers: [DocumentTemplateService],
    }).compile();

    controller = module.get<DocumentTemplateController>(DocumentTemplateController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
