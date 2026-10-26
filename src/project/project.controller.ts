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
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';

import { ProjectService } from './project.service';
import { ProjectAiService } from './project-ai.service';
import type { SaveSpecificationPayload } from './project-ai.service';

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
  // UPLOAD PROJECT SPECIFICATION (NOUVELLE ARCHITECTURE)
  // =========================================================

  /**
   * 1. Route pour générer le token d'upload direct vers Vercel Blob.
   * Appelée par le navigateur du client (via @vercel/blob/client).
   */
@Post('upload-token')
async getUploadToken(@Body() body: { pathname: string }) {
  // 👇 On passe explicitement le token pour éviter tout conflit
  const token = await generateClientTokenFromReadWriteToken({
    token: process.env.BLOB_READ_WRITE_TOKEN, 
    pathname: body.pathname,
    allowedContentTypes: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    maximumSizeInBytes: 15 * 1024 * 1024,
    validUntil: Date.now() + 300000,
  });
  
  return { token };
}


  /**
   * 2. Route pour sauvegarder les métadonnées de la spécification.
   * Reçoit l'URL du fichier déjà uploadé sur Vercel Blob (pas le fichier binaire).
   */
  @Post(':id/specification')
  saveSpecification(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() payload: SaveSpecificationPayload,
  ) {
    return this.projectAiService.saveSpecificationFromUrl(id, payload);
  }

  // =========================
  // RUN AI ANALYSIS
  // POST /projects/:id/ai-analysis
  // =========================

  @Post(':id/ai-analysis')
  analyzeProject(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectAiService.analyzeProject(id);
  }

  // =========================
  // GET ALL PROJECT AI ANALYSES
  // GET /projects/:id/ai-analysis
  // =========================

  @Get(':id/ai-analysis')
  getProjectAnalyses(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectAiService.getProjectAnalyses(id);
  }

  // =========================
  // GET ONE AI ANALYSIS
  // GET /projects/:id/ai-analysis/:analysisId
  // =========================

  @Get(':id/ai-analysis/:analysisId')
  getAnalysis(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('analysisId', ParseUUIDPipe) analysisId: string,
  ) {
    return this.projectAiService.getAnalysis(id, analysisId);
  }
}