
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'src/prisma/prisma.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

import { put, get, del } from '@vercel/blob';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {Multer} from 'multer';
@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  private getBlobToken(): string {
    const token = process.env.BLOB_READ_WRITE_TOKEN;

    if (!token) {
      throw new Error('BLOB_READ_WRITE_TOKEN is not configured');
    }

    return token;
  }

  private validateImage(file: Express.Multer.File): string {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Fichier image invalide');
    }

    const allowedMimeTypes = [
      'image/jpeg',
      'image/png',
      'image/webp',
    ];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        'Format image non autorisé. Utilisez JPG, PNG ou WEBP.',
      );
    }

    const extension = extname(file.originalname).toLowerCase();
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp'];

    if (!allowedExtensions.includes(extension)) {
      throw new BadRequestException(
        'Extension de fichier non autorisée',
      );
    }

    return extension;
  }

  // Envoyer une image CIN dans Vercel Blob privé.
  private async saveImage(
    file: Express.Multer.File,
  ): Promise<string> {
    const extension = this.validateImage(file);
    const token = this.getBlobToken();
    const filename = `${randomUUID()}${extension}`;

    const blob = await put(
      `employees/cin/${filename}`,
      file.buffer,
      {
        access: 'private',
        addRandomSuffix: false,
        contentType: file.mimetype,
        token,
      },
    );

    return blob.url;
  }

  // Supprimer une image Blob si elle existe.
  private async deleteBlobImage(
    imageUrl?: string | null,
  ): Promise<void> {
    if (
      !imageUrl ||
      !imageUrl.startsWith('https://') ||
      !imageUrl.includes('.blob.vercel-storage.com/')
    ) {
      // Ne pas essayer de supprimer les anciens chemins locaux.
      return;
    }

    await del(imageUrl, {
      token: this.getBlobToken(),
    });
  }

  async create(
    createEmployeeDto: CreateEmployeeDto,
    addedById: string,
    files: {
      cinCardFrontImage?: Express.Multer.File[];
      cinCardBackImage?: Express.Multer.File[];
    },
  ) {
    const frontImage = files?.cinCardFrontImage?.[0];
    const backImage = files?.cinCardBackImage?.[0];

    if (!frontImage || !backImage) {
      throw new BadRequestException(
        'Les deux images de la CIN sont obligatoires',
      );
    }

    // Vérifier les deux images avant de les envoyer.
    this.validateImage(frontImage);
    this.validateImage(backImage);

    let frontImageUrl: string | undefined;
    let backImageUrl: string | undefined;

    try {
      frontImageUrl = await this.saveImage(frontImage);
      backImageUrl = await this.saveImage(backImage);

      return await this.prisma.employee.create({
        data: {
          ...createEmployeeDto,
          cinCardFrontImage: frontImageUrl,
          cinCardBackImage: backImageUrl,
          addedById,
        },
        include: {
          addedBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              role: true,
            },
          },
        },
      });
    } catch (error) {
      // Éviter de conserver les images si la création échoue.
      await Promise.allSettled([
        this.deleteBlobImage(frontImageUrl),
        this.deleteBlobImage(backImageUrl),
      ]);

      throw error;
    }
  }

  async findAll() {
    return this.prisma.employee.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        addedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            role: true,
          },
        },
      },
    });
  }

  async findOne(id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: {
        addedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            role: true,
          },
        },
      },
    });

    if (!employee) {
      throw new NotFoundException('Employé introuvable');
    }

    return employee;
  }

  async update(
    id: string,
    updateEmployeeDto: UpdateEmployeeDto,
    files?: {
      cinCardFrontImage?: Express.Multer.File[];
      cinCardBackImage?: Express.Multer.File[];
    },
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
    });

    if (!employee) {
      throw new NotFoundException('Employé introuvable');
    }

    const frontFile = files?.cinCardFrontImage?.[0];
    const backFile = files?.cinCardBackImage?.[0];

    if (frontFile) this.validateImage(frontFile);
    if (backFile) this.validateImage(backFile);

    let newFrontUrl: string | undefined;
    let newBackUrl: string | undefined;

    try {
      if (frontFile) {
        newFrontUrl = await this.saveImage(frontFile);
      }

      if (backFile) {
        newBackUrl = await this.saveImage(backFile);
      }

      const updatedEmployee = await this.prisma.employee.update({
        where: { id },
        data: {
          ...updateEmployeeDto,
          ...(newFrontUrl
            ? { cinCardFrontImage: newFrontUrl }
            : {}),
          ...(newBackUrl
            ? { cinCardBackImage: newBackUrl }
            : {}),
        },
        include: {
          addedBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              role: true,
            },
          },
        },
      });

      // Supprimer les anciennes images seulement après la mise à jour.
      await Promise.allSettled([
        newFrontUrl
          ? this.deleteBlobImage(employee.cinCardFrontImage)
          : Promise.resolve(),
        newBackUrl
          ? this.deleteBlobImage(employee.cinCardBackImage)
          : Promise.resolve(),
      ]);

      return updatedEmployee;
    } catch (error) {
      // Si la mise à jour échoue, supprimer les nouveaux fichiers.
      await Promise.allSettled([
        this.deleteBlobImage(newFrontUrl),
        this.deleteBlobImage(newBackUrl),
      ]);

      throw error;
    }
  }

  async deactivate(id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
    });

    if (!employee) {
      throw new NotFoundException('Employé introuvable');
    }

    return this.prisma.employee.update({
      where: { id },
      data: { isActive: false },
      include: {
        addedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            role: true,
          },
        },
      },
    });
  }

  async activate(id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
    });

    if (!employee) {
      throw new NotFoundException('Employé introuvable');
    }

    return this.prisma.employee.update({
      where: { id },
      data: { isActive: true },
      include: {
        addedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            role: true,
          },
        },
      },
    });
  }

  async delete(id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
    });

    if (!employee) {
      throw new NotFoundException('Employé introuvable');
    }

    await this.prisma.employee.delete({
      where: { id },
    });

    await Promise.allSettled([
      this.deleteBlobImage(employee.cinCardFrontImage),
      this.deleteBlobImage(employee.cinCardBackImage),
    ]);

    return {
      message: 'Employé supprimé avec succès',
      id,
    };
  }

  // Lecture d'une image privée : à exposer via une route protégée.
  async getPrivateImage(imageUrl: string): Promise<Buffer> {
    if (
      !imageUrl.startsWith('https://') ||
      !imageUrl.includes('.blob.vercel-storage.com/')
    ) {
      throw new BadRequestException('URL Blob invalide');
    }

    const result = await get(imageUrl, {
      access: 'private',
      token: this.getBlobToken(),
    });

    if (!result || result.statusCode !== 200 || !result.stream) {
      throw new NotFoundException('Image introuvable');
    }

    const chunks: Buffer[] = [];

    for await (const chunk of result.stream) {
      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }
}
