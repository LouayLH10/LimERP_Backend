import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { UsersService } from './user.service'; 
import { CreateUserDto } from './dto/create-user.dto';

import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';

import { UserRole } from 'src/generated/prisma/enums';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
  ) {}

  @Post('admins')
  createAdmin(
    @Body() createUserDto: CreateUserDto,
  ) {
    return this.usersService.createAdmin(
      createUserDto,
    );
  }

  @Patch('admin/:id/block')
  blockAdmin(
    @Param('id') id: string,
  ) {
    return this.usersService.blockAdmin(id);
  }

  @Patch('admins/:id/unblock')
  unblockAdmin(
    @Param('id') id: string,
  ) {
    return this.usersService.unblockAdmin(id);
  }
  
@Get('admins')
@Roles(UserRole.SUPER_ADMIN)
getAdmins() {
  return this.usersService.getAdmins();
}

}
