import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  Res, // 👈 IMPORTANT : Ajout de Res
  NotFoundException, // 👈 IMPORTANT : Ajout de NotFoundException
} from '@nestjs/common';

import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Express, Response } from 'express'; // 👈 Ajout de Response

import { EmployeesService } from './employee.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

import { UserRole } from '../generated/prisma/enums';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('employees')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeeController {
  constructor(
    private readonly employeeService: EmployeesService,
  ) {}

  // SUPER_ADMIN + ADMIN
  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'cinCardFrontImage', maxCount: 1 },
      { name: 'cinCardBackImage', maxCount: 1 },
    ]),
  )
  create(
    @Body() createEmployeeDto: CreateEmployeeDto,
    @UploadedFiles()
    files: {
      cinCardFrontImage?: Express.Multer.File[];
      cinCardBackImage?: Express.Multer.File[];
    },
    @CurrentUser() user: any,
  ) {
    console.log('========== CREATE EMPLOYEE ==========');
    console.log('DTO reçu :', createEmployeeDto);
    console.log('Fichiers reçus :', files);
    
    return this.employeeService.create(
      createEmployeeDto,
      user.id,
      files,
    );
  }

  // SUPER_ADMIN + ADMIN
  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  findAll() {
    return this.employeeService.findAll();
  }

  // SUPER_ADMIN + ADMIN
  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  findOne(@Param('id') id: string) {
    return this.employeeService.findOne(id);
  }

  // 👇👇👇 LA NOUVELLE ROUTE POUR LES IMAGES CIN 👇👇👇
  @Get(':id/cin/:side')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async getCinImage(
    @Param('id') id: string,
    @Param('side') side: 'front' | 'back',
    @Res() res: Response,
  ) {
    console.log(`\n=== [BACKEND] Route /employees/${id}/cin/${side} appelée ===`);

    // 1. Récupérer l'employé
    const employee = await this.employeeService.findOne(id);
    
    if (!employee) {
      throw new NotFoundException('Employé introuvable');
    }

    // 2. Déterminer quelle image récupérer
    const imageUrl =
      side === 'front'
        ? employee.cinCardFrontImage
        : employee.cinCardBackImage;

    console.log(`[BACKEND] URL en base pour ${side} :`, imageUrl);

    if (!imageUrl) {
      console.log(`[BACKEND] ❌ Aucune URL trouvée pour ${side}`);
      throw new NotFoundException(`Image ${side} introuvable en base`);
    }

    // 3. Lire le fichier depuis le service
    try {
      console.log(`[BACKEND] Lecture du Blob Vercel...`);
      const buffer = await this.employeeService.getPrivateImage(imageUrl);
      
      console.log(`[BACKEND] ✅ Image lue avec succès. Taille : ${buffer.length} bytes`);

      // 4. Envoyer l'image
      res.setHeader('Content-Type', 'image/jpeg'); // (ou image/png selon le fichier)
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(buffer);
      
    } catch (error: any) {
      console.error(`[BACKEND] ❌ Erreur lors de la lecture du Blob :`, error.message);
      throw new NotFoundException(`Impossible de charger l'image ${side}`);
    }
  }
  // 👆👆👆 FIN DE LA NOUVELLE ROUTE 👆👆👆

  // SUPER_ADMIN + ADMIN
  @Patch(":id")
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: "cinCardFrontImage", maxCount: 1 },
      { name: "cinCardBackImage", maxCount: 1 },
    ]),
  )
  update(
    @Param("id") id: string,
    @Body() updateEmployeeDto: UpdateEmployeeDto,
    @UploadedFiles()
    files: {
      cinCardFrontImage?: Express.Multer.File[];
      cinCardBackImage?: Express.Multer.File[];
    },
  ) {
    return this.employeeService.update(
      id,
      updateEmployeeDto,
      files,
    );
  }

  // SUPER_ADMIN + ADMIN
  @Patch(':id/activate')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  activate(@Param('id') id: string) {
    return this.employeeService.activate(id);
  }

  // SUPER_ADMIN + ADMIN
  @Patch(':id/deactivate')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  deactivate(@Param('id') id: string) {
    return this.employeeService.deactivate(id);
  }

  @Delete(":id")
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  delete(@Param("id") id: string) {
    return this.employeeService.delete(id);
  }
}