import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TimesheetService } from './timesheet.service';
import { CreateTimeSheetDto } from './dto/create-timesheet.dto';
import { UpdateTimeSheetDto } from './dto/update-timesheet.dto'; 
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { UserRole } from 'src/generated/prisma/enums';
import { Roles } from 'src/auth/decorators/roles.decorator';
// import { JwtAuthGuard } from '../auth/jwt-auth.guard'; // si vous avez un guard

@Controller('projects/:projectId/timesheet')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class TimesheetController {
  constructor(private readonly timesheet: TimesheetService) {}

  @Post()
  upsert(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateTimeSheetDto,
  ) {
    return this.timesheet.upsert(projectId, dto);
  }

  @Get()
  findAll(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.timesheet.findByProject(projectId);
  }

  @Get('summary')
  summary(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.timesheet.summaryByProject(projectId);
  }

  @Get('employee/:employeeId')
  findByEmployee(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ) {
    return this.timesheet.findByProjectAndEmployee(projectId, employeeId);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTimeSheetDto,
  ) {
    return this.timesheet.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.timesheet.remove(id);
  }
}