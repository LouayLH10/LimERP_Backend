import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';

import { PrismaService } from 'src/prisma/prisma.service';

import { CreateUserDto } from './dto/create-user.dto';

import { UserRole } from 'src/generated/prisma/enums';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async createAdmin(createUserDto: CreateUserDto) {
    const existingEmail = await this.prisma.user.findUnique({
      where: {
        email: createUserDto.email,
      },
    });

    if (existingEmail) {
      throw new ConflictException(
        'A user with this email already exists',
      );
    }

    const existingPhone = await this.prisma.user.findUnique({
      where: {
        phone: createUserDto.phone,
      },
    });

    if (existingPhone) {
      throw new ConflictException(
        'A user with this phone number already exists',
      );
    }

    return this.prisma.user.create({
      data: {
        firstName: createUserDto.firstName,
        lastName: createUserDto.lastName,
        email: createUserDto.email,
        phone: createUserDto.phone,
        role: UserRole.ADMIN,
        isBlocked: false,
      },

      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        role: true,
        isBlocked: true,
        createdAt: true,
      },
    });
  }

  async blockAdmin(id: string) {
    const admin = await this.prisma.user.findUnique({
      where: {
        id,
      },
    });

    if (!admin) {
      throw new NotFoundException(
        'Admin account not found',
      );
    }

    if (admin.role !== UserRole.ADMIN) {
      throw new BadRequestException(
        'Only ADMIN accounts can be blocked',
      );
    }

    if (admin.isBlocked) {
      throw new BadRequestException(
        'Admin account is already blocked',
      );
    }

    return this.prisma.user.update({
      where: {
        id,
      },
      data: {
        isBlocked: true,
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        role: true,
        isBlocked: true,
        updatedAt: true,
      },
    });
  }

  async unblockAdmin(id: string) {
    const admin = await this.prisma.user.findUnique({
      where: {
        id,
      },
    });

    if (!admin) {
      throw new NotFoundException(
        'Admin account not found',
      );
    }

    if (admin.role !== UserRole.ADMIN) {
      throw new BadRequestException(
        'Only ADMIN accounts can be unblocked',
      );
    }

    if (!admin.isBlocked) {
      throw new BadRequestException(
        'Admin account is already unblocked',
      );
    }

    return this.prisma.user.update({
      where: {
        id,
      },
      data: {
        isBlocked: false,
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        role: true,
        isBlocked: true,
        updatedAt: true,
      },
    });
  }
  
async getAdmins() {
  return this.prisma.user.findMany({
    where: {
      role: UserRole.ADMIN,
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      role: true,
      isBlocked: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

}
