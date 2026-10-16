import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'src/prisma/prisma.service';

import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  // Enregistrer une image sur le serveur
  private async saveImage(
    file: Express.Multer.File,
  ): Promise<string> {
    if (!file || !file.buffer) {
      throw new BadRequestException(
        'Fichier image invalide',
      );
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

    const uploadDirectory = join(
      process.cwd(),
      'uploads',
      'employees',
    );

    await mkdir(uploadDirectory, {
      recursive: true,
    });

    const filename = `${randomUUID()}${extension}`;

    const filePath = join(
      uploadDirectory,
      filename,
    );

    await writeFile(filePath, file.buffer);

    // Chemin relatif enregistré dans la base de données
    return `uploads/employees/${filename}`;
  }

  // Créer un employé
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
console.log(frontImage)
    if (!frontImage || !backImage) {
      throw new BadRequestException(
        'Les deux images de la CIN sont obligatoires',
      );
    }

    // Enregistrer les fichiers avant de sauvegarder leurs chemins
    const frontImagePath = await this.saveImage(frontImage);
    const backImagePath = await this.saveImage(backImage);

    return this.prisma.employee.create({
      data: {
        ...createEmployeeDto,

        // Remplacer les éventuelles valeurs reçues par les chemins
        cinCardFrontImage: frontImagePath,
        cinCardBackImage: backImagePath,

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
  }

  async findAll() {
    return this.prisma.employee.findMany({
      orderBy: {
        createdAt: 'desc',
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
  }

  async findOne(id: string) {
    return this.prisma.employee.findUnique({
      where: {
        id,
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
    throw new NotFoundException("Employé introuvable");
  }

  const frontFile = files?.cinCardFrontImage?.[0];
  const backFile = files?.cinCardBackImage?.[0];

  // Ne remplacer les images que si de nouveaux fichiers sont envoyés.
  const frontImagePath = frontFile
    ? await this.saveImage(frontFile)
    : undefined;

  const backImagePath = backFile
    ? await this.saveImage(backFile)
    : undefined;

  return this.prisma.employee.update({
    where: { id },
    data: {
      ...updateEmployeeDto,

      ...(frontImagePath
        ? { cinCardFrontImage: frontImagePath }
        : {}),

      ...(backImagePath
        ? { cinCardBackImage: backImagePath }
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
}


  async deactivate(id: string) {
    return this.prisma.employee.update({
      where: {
        id,
      },
      data: {
        isActive: false,
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
  }

  async activate(id: string) {
    return this.prisma.employee.update({
      where: {
        id,
      },
      data: {
        isActive: true,
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
  }
  
async delete(id: string) {
  const employee = await this.prisma.employee.findUnique({
    where: { id },
  });

  if (!employee) {
    throw new NotFoundException("Employé introuvable");
  }

  await this.prisma.employee.delete({
    where: { id },
  });

  return {
    message: "Employé supprimé avec succès",
    id,
  };
}
}
