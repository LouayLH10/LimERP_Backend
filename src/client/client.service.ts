import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'src/prisma/prisma.service';

import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';

@Injectable()
export class ClientService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  // =======================================================
  // CREATE
  // =======================================================

  async create(createClientDto: CreateClientDto) {
    const {
      companyName,
      email,
      phone,
      address,
      city,
      country,
    } = createClientDto;

    // 👇 Suppression de la vérification du taxId

    return this.prisma.client.create({
      data: {
        companyName,
        email,
        phone,
        address,
        city,
        country,
      },
    });
  }

  // =======================================================
  // FIND ALL
  // =======================================================

  async findAll() {
    return this.prisma.client.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // =======================================================
  // FIND ONE
  // =======================================================

  async findOne(id: string) {
    const client = await this.prisma.client.findUnique({
      where: {
        id,
      },
    });

    if (!client) {
      throw new NotFoundException(
        'Client not found',
      );
    }

    return client;
  }

  // =======================================================
  // UPDATE
  // =======================================================

  async update(
    id: string,
    updateClientDto: UpdateClientDto,
  ) {
    // Vérifier le client
    const client = await this.prisma.client.findUnique({
      where: {
        id,
      },
    });

    if (!client) {
      throw new NotFoundException(
        'Client not found',
      );
    }

    // 👇 Suppression de la vérification du taxId

    return this.prisma.client.update({
      where: {
        id,
      },
      data: updateClientDto,
    });
  }

  // =======================================================
  // ACTIVATE
  // =======================================================

  async activate(id: string) {
    const client = await this.prisma.client.findUnique({
      where: {
        id,
      },
    });

    if (!client) {
      throw new NotFoundException(
        'Client not found',
      );
    }

    return this.prisma.client.update({
      where: {
        id,
      },
      data: {
        isActive: true,
      },
    });
  }

  // =======================================================
  // DEACTIVATE
  // =======================================================

  async deactivate(id: string) {
    const client = await this.prisma.client.findUnique({
      where: {
        id,
      },
    });

    if (!client) {
      throw new NotFoundException(
        'Client not found',
      );
    }

    return this.prisma.client.update({
      where: {
        id,
      },
      data: {
        isActive: false,
      },
    });
  }

  // =======================================================
  // DELETE
  // =======================================================

  async remove(id: string) {
    const client = await this.prisma.client.findUnique({
      where: {
        id,
      },
    });

    if (!client) {
      throw new NotFoundException(
        'Client not found',
      );
    }

    return this.prisma.client.delete({
      where: {
        id,
      },
    });
  }
}