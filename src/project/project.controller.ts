import {
Body,
Controller,
Delete,
Get,
Param,
Patch,
Post,
UseGuards,
} from '@nestjs/common';

import { ProjectService } from './project.service';
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
) {}

/**

* Create a project
* POST /projects
  */
  @Post()
  create(@Body() createProjectDto: CreateProjectDto) {
  return this.projectService.create(createProjectDto);
  }

/**

* Get all projects
* GET /projects
  */
  @Get()
  findAll() {
  return this.projectService.findAll();
  }

/**

* Get one project
* GET /projects/:id
  */
  @Get(':id')
  findOne(@Param('id') id: string) {
  return this.projectService.findOne(id);
  }

/**

* Update a project
* PATCH /projects/:id
  */
  @Patch(':id')
  update(
  @Param('id') id: string,
  @Body() updateProjectDto: UpdateProjectDto,
  ) {
  return this.projectService.update(
  id,
  updateProjectDto,
  );
  }

/**

* Delete a project
* DELETE /projects/:id
  */
  @Delete(':id')
  remove(@Param('id') id: string) {
  return this.projectService.remove(id);
  }
  }
