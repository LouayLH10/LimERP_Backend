import { Test, TestingModule } from '@nestjs/testing';
import { DocumentTemplateService } from './document-template.service';

describe('DocumentTemplateService', () => {
  let service: DocumentTemplateService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DocumentTemplateService],
    }).compile();

    service = module.get<DocumentTemplateService>(DocumentTemplateService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
