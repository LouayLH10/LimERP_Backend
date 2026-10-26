import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
  Res,
  NotFoundException,
  Req,
} from '@nestjs/common';
import type { Response } from 'express';
import { generateClientTokenFromReadWriteToken} from '@vercel/blob/client';
import { handleUpload } from '@vercel/blob/client';
import type { HandleUploadBody } from '@vercel/blob/client';
import { ProjectService } from './project.service';
import { ProjectAiService } from './project-ai.service';

import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../generated/prisma/enums';

@Controller('projects')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
export class ProjectController {
  constructor(
    private readonly projectService: ProjectService,
    private readonly projectAiService: ProjectAiService,
  ) {}

  // =========================
  // CRUD PROJECTS
  // =========================
  @Post()
  create(@Body() createProjectDto: CreateProjectDto) {
    return this.projectService.create(createProjectDto);
  }

  @Get()
  findAll() {
    return this.projectService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateProjectDto: UpdateProjectDto,
  ) {
    return this.projectService.update(id, updateProjectDto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectService.remove(id);
  }

  // =========================================================
  // UPLOAD DIRECT (PRESIGNED URL)
  // =========================================================

  /**
   * 1. Générer l'URL d'upload sécurisée
   */
  @Post('upload-token')
async getUploadToken(
  @Body() body: HandleUploadBody,
  @Req() req: Request,
) {
  return await handleUpload({
    body,
    request: req as unknown as globalThis.Request,
    onBeforeGenerateToken: async () => ({
      allowedContentTypes: [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      maximumSizeInBytes: 15 * 1024 * 1024,
      validUntil: Date.now() + 300000, // 5 minutes (important pour les gros fichiers)
    }),
    onUploadCompleted: async ({ blob }) => {
      console.log('Upload terminé:', blob.url);
    },
  });
}
  @Post(':id/upload-url')
  async getUploadUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { fileName: string; fileType: string },
  ) {
    const token = await generateClientTokenFromReadWriteToken({
      token: process.env.BLOB_READ_WRITE_TOKEN,
      pathname: `specifications/${body.fileName}`,
      allowedContentTypes: [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      maximumSizeInBytes: 15 * 1024 * 1024, // 15 Mo
      validUntil: Date.now() + 300000, // 5 minutes
    });

    // On renvoie l'URL d'upload générée par Vercel
    const uploadUrl = `https://blob.vercel-storage.com/specifications/${body.fileName}`;

    return { uploadUrl, token };
  }

  /**
   * 2. Traiter le fichier après l'upload direct
   */
  @Post(':id/specification/process')
  async processSpecification(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { fileName: string; fileType: string },
  ) {
    return this.projectAiService.processSpecificationFromVercel(
      id,
      body.fileName,
      body.fileType,
    );
  }

  // =========================================================
  // GET SPECIFICATION FILE (Download)
  // =========================================================
  @Get(':id/specification/file')
  async getSpecificationFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const specification = await this.projectAiService.getSpecification(id);

    if (!specification || !specification.storagePath) {
      throw new NotFoundException('Cahier des charges introuvable');
    }

    try {
      const buffer = await this.projectAiService.getPrivateFile(specification.storagePath);
      
      res.setHeader('Content-Type', specification.mimeType);
      res.setHeader('Content-Disposition', `inline; filename="${specification.originalName}"`);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(buffer);
    } catch (error) {
      throw new NotFoundException('Impossible de charger le fichier');
    }
  }

  // =========================
  // AI ANALYSIS
  // =========================
  @Post(':id/ai-analysis')
  analyzeProject(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectAiService.analyzeProject(id);
  }

  @Get(':id/ai-analysis')
  getProjectAnalyses(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectAiService.getProjectAnalyses(id);
  }

  @Get(':id/ai-analysis/:analysisId')
  getAnalysis(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('analysisId', ParseUUIDPipe) analysisId: string,
  ) {
    return this.projectAiService.getAnalysis(id, analysisId);
  }
}