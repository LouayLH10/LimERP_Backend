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
} from '@nestjs/common';

import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Express } from 'express';

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
  console.log('Content-Type:', 'Vérifie également dans Network');
  console.log('DTO reçu :', createEmployeeDto);
  console.log('Fichiers reçus :', files);
  console.log(
    'Recto :',
    files?.cinCardFrontImage?.[0]?.originalname,
  );
  console.log(
    'Verso :',
    files?.cinCardBackImage?.[0]?.originalname,
  );

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

  // SUPER_ADMIN + ADMIN

@Patch(":id")
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
delete(@Param("id") id: string) {
  return this.employeeService.delete(id);
}

}
