import {
  ConflictException,
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
      taxId,
    } = createClientDto;

    // Vérifier le taxId s'il est fourni
    if (taxId) {
      const existingClient =
        await this.prisma.client.findUnique({
          where: {
            taxId,
          },
        });

      if (existingClient) {
        throw new ConflictException(
          'A client with this tax ID already exists',
        );
      }
    }

    return this.prisma.client.create({
      data: {
        companyName,
        email,
        phone,
        address,
        city,
        country,
        taxId,
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

    // Vérifier taxId s'il est modifié
    if (updateClientDto.taxId !== undefined) {
      const existingClient =
        await this.prisma.client.findUnique({
          where: {
            taxId: updateClientDto.taxId,
          },
        });

      if (
        existingClient &&
        existingClient.id !== id
      ) {
        throw new ConflictException(
          'A client with this tax ID already exists',
        );
      }
    }

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
