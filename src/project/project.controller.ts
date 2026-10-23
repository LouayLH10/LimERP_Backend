
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
  UploadedFile,
  UseGuards,
  UseInterceptors,
  MaxFileSizeValidator,
  ParseFilePipe,
  FileTypeValidator,
} from '@nestjs/common';

import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

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

  // =========================
  // UPLOAD PROJECT SPECIFICATION
  // POST /projects/:id/specification
  // =========================

  @Post(':id/specification')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: 15 * 1024 * 1024, // 15 MB
      },
      fileFilter: (_req, file, callback) => {
        const allowedMimeTypes = [
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ];

        const allowedExtensions = /\.(pdf|docx)$/i;

        if (
          !allowedMimeTypes.includes(file.mimetype) ||
          !allowedExtensions.test(file.originalname)
        ) {
          return callback(
            new BadRequestException(
              'Seuls les fichiers PDF et DOCX sont autorisés.',
            ),
            false,
          );
        }

        callback(null, true);
      },
    }),
  )
  uploadSpecification(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({
            maxSize: 15 * 1024 * 1024,
          }),
          new FileTypeValidator({
            fileType:
              /^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/,
          }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.projectAiService.uploadSpecification(id, file);
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
