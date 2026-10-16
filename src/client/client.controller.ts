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

import { ClientService } from './client.service';

import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';

import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';

import { UserRole } from 'src/generated/prisma/enums';

@Controller('clients')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
export class ClientController {
  constructor(
    private readonly clientService: ClientService,
  ) {}

  // =======================================================
  // Create client
  // POST /clients
  // =======================================================

  @Post()
  create(
    @Body() createClientDto: CreateClientDto,
  ) {
    return this.clientService.create(
      createClientDto,
    );
  }

  // =======================================================
  // Get all clients
  // GET /clients
  // =======================================================

  @Get()
  findAll() {
    return this.clientService.findAll();
  }

  // =======================================================
  // Get one client
  // GET /clients/:id
  // =======================================================

  @Get(':id')
  findOne(
    @Param('id') id: string,
  ) {
    return this.clientService.findOne(id);
  }

  // =======================================================
  // Update client
  // PATCH /clients/:id
  // =======================================================

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateClientDto: UpdateClientDto,
  ) {
    return this.clientService.update(
      id,
      updateClientDto,
    );
  }

  // =======================================================
  // Activate client
  // PATCH /clients/:id/activate
  // =======================================================

  @Patch(':id/activate')
  activate(
    @Param('id') id: string,
  ) {
    return this.clientService.activate(id);
  }

  // =======================================================
  // Deactivate client
  // PATCH /clients/:id/deactivate
  // =======================================================

  @Patch(':id/deactivate')
  deactivate(
    @Param('id') id: string,
  ) {
    return this.clientService.deactivate(id);
  }

  // =======================================================
  // Delete client
  // DELETE /clients/:id
  // =======================================================

  @Delete(':id')
  remove(
    @Param('id') id: string,
  ) {
    return this.clientService.remove(id);
  }
}
