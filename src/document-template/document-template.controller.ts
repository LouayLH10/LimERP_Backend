import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';

import { FileInterceptor } from '@nestjs/platform-express';

import { DocumentTemplateService } from './document-template.service';

import { CreateDocumentTemplateDto } from './dto/create-document-template.dto';
import { UpdateDocumentTemplateDto } from './dto/update-document-template.dto';
import { UpdateTemplateStyleDto } from './dto/create-document-template.dto';

import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';

import { DocumentType, UserRole } from 'src/generated/prisma/enums';

@Controller('document-templates')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
export class DocumentTemplateController {
  constructor(
    private readonly documentTemplateService: DocumentTemplateService,
  ) {}

  @Post()
  create(
    @Body() createDto: CreateDocumentTemplateDto,
  ) {
    return this.documentTemplateService.create(createDto);
  }

  @Get()
  findAll() {
    return this.documentTemplateService.findAll();
  }

  @Get('active')
  findActive() {
    return this.documentTemplateService.findActive();
  }

  @Get('default/:type')
  findDefault(@Param('type') type: string) {
    return this.documentTemplateService.findDefault(
      type as DocumentType,
    );
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.documentTemplateService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateDto: UpdateDocumentTemplateDto,
  ) {
    return this.documentTemplateService.update(
      id,
      updateDto,
    );
  }

  @Patch(':id/default')
  setDefault(@Param('id') id: string) {
    return this.documentTemplateService.setDefault(id);
  }

  @Patch(':id/style')
  updateStyle(
    @Param('id') id: string,
    @Body() updateDto: UpdateTemplateStyleDto,
  ) {
    return this.documentTemplateService.updateStyle(
      id,
      updateDto,
    );
  }

  @Get(':id/style')
  getStyle(@Param('id') id: string) {
    return this.documentTemplateService.getStyle(id);
  }

  /**
   * Upload a new template version.
   *
   * Field name expected by multipart/form-data:
   * "file"
   */
  @Post(':id/versions')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: 5 * 1024 * 1024,
      },
    }),
  )
  uploadVersion(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.documentTemplateService.uploadVersion(
      id,
      file,
    );
  }

  @Get(':id/versions')
  findVersions(@Param('id') id: string) {
    return this.documentTemplateService.findVersions(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.documentTemplateService.remove(id);
  }
  @Get(':id/preview')
async getTemplatePreview(@Param('id') id: string) {
  return this.documentTemplateService.getTemplatePreview(id);
}
}
