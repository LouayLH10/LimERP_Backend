
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { Prisma } from 'src/generated/prisma/client';
import { DocumentType } from 'src/generated/prisma/enums';
import { PrismaService } from 'src/prisma/prisma.service';

import * as Handlebars from 'handlebars';
import { put, del } from '@vercel/blob';

import { CreateDocumentTemplateDto } from './dto/create-document-template.dto';
import { UpdateDocumentTemplateDto } from './dto/update-document-template.dto';
import { UpdateTemplateStyleDto } from './dto/create-document-template.dto';

@Injectable()
export class DocumentTemplateService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createDto: CreateDocumentTemplateDto) {
    const existingTemplate =
      await this.prisma.documentTemplate.findUnique({
        where: {
          type_name: {
            type: createDto.type,
            name: createDto.name,
          },
        },
      });

    if (existingTemplate) {
      throw new BadRequestException(
        'A template with this name already exists for this document type',
      );
    }

    if (createDto.isDefault === true) {
      await this.prisma.documentTemplate.updateMany({
        where: {
          type: createDto.type,
          isDefault: true,
        },
        data: {
          isDefault: false,
        },
      });
    }

    return this.prisma.documentTemplate.create({
      data: {
        name: createDto.name,
        type: createDto.type,
        description: createDto.description ?? null,
        isDefault: createDto.isDefault ?? false,
        isActive: createDto.isActive ?? true,
      },
      include: {
        versions: {
          orderBy: {
            version: 'desc',
          },
        },
        style: true,
      },
    });
  }

  async findAll() {
    return this.prisma.documentTemplate.findMany({
      orderBy: [
        {
          type: 'asc',
        },
        {
          isDefault: 'desc',
        },
        {
          name: 'asc',
        },
      ],
      include: {
        versions: {
          orderBy: {
            version: 'desc',
          },
        },
        style: true,
      },
    });
  }

  async findActive() {
    return this.prisma.documentTemplate.findMany({
      where: {
        isActive: true,
      },
      orderBy: [
        {
          type: 'asc',
        },
        {
          isDefault: 'desc',
        },
        {
          name: 'asc',
        },
      ],
      include: {
        versions: {
          orderBy: {
            version: 'desc',
          },
        },
        style: true,
      },
    });
  }

  async findOne(id: string) {
    const template =
      await this.prisma.documentTemplate.findUnique({
        where: { id },
        include: {
          versions: {
            orderBy: {
              version: 'desc',
            },
          },
          style: true,
        },
      });

    if (!template) {
      throw new NotFoundException(
        'Document template not found',
      );
    }

    return template;
  }

  async findDefault(type: DocumentType) {
    const template =
      await this.prisma.documentTemplate.findFirst({
        where: {
          type,
          isDefault: true,
          isActive: true,
        },
        include: {
          versions: {
            orderBy: {
              version: 'desc',
            },
          },
          style: true,
        },
      });

    if (!template) {
      throw new NotFoundException(
        `No default template found for document type ${type}`,
      );
    }

    return template;
  }

  async update(
    id: string,
    updateDto: UpdateDocumentTemplateDto,
  ) {
    const template =
      await this.prisma.documentTemplate.findUnique({
        where: { id },
      });

    if (!template) {
      throw new NotFoundException(
        'Document template not found',
      );
    }

    if (
      updateDto.name !== undefined ||
      updateDto.type !== undefined
    ) {
      const newName = updateDto.name ?? template.name;
      const newType = updateDto.type ?? template.type;

      const existingTemplate =
        await this.prisma.documentTemplate.findFirst({
          where: {
            name: newName,
            type: newType,
            NOT: {
              id,
            },
          },
        });

      if (existingTemplate) {
        throw new BadRequestException(
          'A template with this name already exists for this document type',
        );
      }
    }

    const newType = updateDto.type ?? template.type;

    if (updateDto.isDefault === true) {
      await this.prisma.documentTemplate.updateMany({
        where: {
          type: newType,
          isDefault: true,
          NOT: {
            id,
          },
        },
        data: {
          isDefault: false,
        },
      });
    }

    return this.prisma.documentTemplate.update({
      where: { id },
      data: {
        ...(updateDto.name !== undefined && {
          name: updateDto.name,
        }),

        ...(updateDto.type !== undefined && {
          type: updateDto.type,
        }),

        ...(updateDto.description !== undefined && {
          description: updateDto.description,
        }),

        ...(updateDto.isDefault !== undefined && {
          isDefault: updateDto.isDefault,
        }),

        ...(updateDto.isActive !== undefined && {
          isActive: updateDto.isActive,
        }),
      },
      include: {
        versions: {
          orderBy: {
            version: 'desc',
          },
        },
        style: true,
      },
    });
  }

  async setDefault(id: string) {
    const template =
      await this.prisma.documentTemplate.findUnique({
        where: { id },
      });

    if (!template) {
      throw new NotFoundException(
        'Document template not found',
      );
    }

    if (!template.isActive) {
      throw new BadRequestException(
        'An inactive template cannot be set as default',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.documentTemplate.updateMany({
        where: {
          type: template.type,
          isDefault: true,
          NOT: {
            id,
          },
        },
        data: {
          isDefault: false,
        },
      });

      return tx.documentTemplate.update({
        where: { id },
        data: {
          isDefault: true,
        },
        include: {
          versions: {
            orderBy: {
              version: 'desc',
            },
          },
          style: true,
        },
      });
    });
  }

  async updateStyle(
    templateId: string,
    updateDto: UpdateTemplateStyleDto,
  ) {
    const template =
      await this.prisma.documentTemplate.findUnique({
        where: { id: templateId },
      });

    if (!template) {
      throw new NotFoundException(
        'Document template not found',
      );
    }

    return this.prisma.templateStyle.upsert({
      where: {
        templateId,
      },
      create: {
        templateId,
        primaryColor:
          updateDto.primaryColor ?? '#1F2937',
        secondaryColor:
          updateDto.secondaryColor ?? '#6B7280',
        accentColor:
          updateDto.accentColor ?? '#2563EB',
        textColor:
          updateDto.textColor ?? '#111827',
        backgroundColor:
          updateDto.backgroundColor ?? '#FFFFFF',
        fontFamily:
          updateDto.fontFamily ?? 'Arial',
        fontSize:
          updateDto.fontSize ?? 10,
        borderRadius:
          updateDto.borderRadius ?? 0,
        spacing:
          updateDto.spacing ?? 8,
        showLogo:
          updateDto.showLogo ?? true,
        showFooter:
          updateDto.showFooter ?? true,
        showSignature:
          updateDto.showSignature ?? true,
      },
      update: {
        ...(updateDto.primaryColor !== undefined && {
          primaryColor: updateDto.primaryColor,
        }),

        ...(updateDto.secondaryColor !== undefined && {
          secondaryColor: updateDto.secondaryColor,
        }),

        ...(updateDto.accentColor !== undefined && {
          accentColor: updateDto.accentColor,
        }),

        ...(updateDto.textColor !== undefined && {
          textColor: updateDto.textColor,
        }),

        ...(updateDto.backgroundColor !== undefined && {
          backgroundColor: updateDto.backgroundColor,
        }),

        ...(updateDto.fontFamily !== undefined && {
          fontFamily: updateDto.fontFamily,
        }),

        ...(updateDto.fontSize !== undefined && {
          fontSize: updateDto.fontSize,
        }),

        ...(updateDto.borderRadius !== undefined && {
          borderRadius: updateDto.borderRadius,
        }),

        ...(updateDto.spacing !== undefined && {
          spacing: updateDto.spacing,
        }),

        ...(updateDto.showLogo !== undefined && {
          showLogo: updateDto.showLogo,
        }),

        ...(updateDto.showFooter !== undefined && {
          showFooter: updateDto.showFooter,
        }),

        ...(updateDto.showSignature !== undefined && {
          showSignature: updateDto.showSignature,
        }),
      },
    });
  }

  async getStyle(templateId: string) {
    const template =
      await this.prisma.documentTemplate.findUnique({
        where: { id: templateId },
        include: {
          style: true,
        },
      });

    if (!template) {
      throw new NotFoundException(
        'Document template not found',
      );
    }

    return template.style;
  }

  /**
   * Upload a new template version.
   *
   * The file is stored locally in:
   * uploads/templates/{templateId}/
   */
 
async uploadVersion(
  templateId: string,
  file: Express.Multer.File,
) {
  if (!file) {
    throw new BadRequestException('Template file is required');
  }

  const template = await this.prisma.documentTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template) {
    throw new NotFoundException('Document template not found');
  }

  const extension = file.originalname
    .split('.')
    .pop()
    ?.toLowerCase();

  if (!extension || !['hbs', 'html'].includes(extension)) {
    throw new BadRequestException(
      'Only .hbs and .html template files are allowed',
    );
  }

  if (!file.buffer || file.buffer.length === 0) {
    throw new BadRequestException('Template file is empty');
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN is not configured');
  }

  const lastVersion = await this.prisma.templateVersion.findFirst({
    where: { templateId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  const nextVersion = lastVersion ? lastVersion.version + 1 : 1;

  const safeFileName = file.originalname
    .replace(/[^a-zA-Z0-9._-]/g, '_');

  const blob = await put(
    `templates/${templateId}/v${nextVersion}-${safeFileName}`,
    file.buffer,
    {
      access: 'public',
      addRandomSuffix: true,
      contentType:
        extension === 'html'
          ? 'text/html; charset=utf-8'
          : 'text/plain; charset=utf-8',
      token: process.env.BLOB_READ_WRITE_TOKEN,
    },
  );

  try {
    const version = await this.prisma.templateVersion.create({
      data: {
        version: nextVersion,
        fileName: file.originalname,
        storagePath: blob.url,
        templateId,
      },
    });

    return {
      message: 'Template version uploaded successfully',
      template,
      version,
    };
  } catch (error) {
    // Nettoyer le fichier Blob si l'enregistrement en base échoue.
    await del(blob.url, {
      token: process.env.BLOB_READ_WRITE_TOKEN,
    }).catch((deleteError) => {
      console.error('Unable to delete orphaned Blob:', deleteError);
    });

    throw error;
  }
}


  async findVersions(templateId: string) {
    const template =
      await this.prisma.documentTemplate.findUnique({
        where: { id: templateId },
      });

    if (!template) {
      throw new NotFoundException(
        'Document template not found',
      );
    }

    return this.prisma.templateVersion.findMany({
      where: {
        templateId,
      },
      orderBy: {
        version: 'desc',
      },
    });
  }


async remove(id: string) {
  const template = await this.prisma.documentTemplate.findUnique({
    where: { id },
    include: { versions: true },
  });

  if (!template) {
    throw new NotFoundException('Document template not found');
  }

  if (template.isDefault) {
    throw new BadRequestException(
      'The default template cannot be deleted. Set another template as default first.',
    );
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN is not configured');
  }

  // Supprimer uniquement les fichiers qui sont des URL Blob.
  for (const version of template.versions) {
    if (
      version.storagePath.startsWith('https://') &&
      version.storagePath.includes('.blob.vercel-storage.com/')
    ) {
      await del(version.storagePath, {
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
    }
  }

  return this.prisma.documentTemplate.delete({
    where: { id },
  });
}



async getTemplatePreview(templateId: string): Promise<string> {
  const template = await this.prisma.documentTemplate.findUnique({
    where: { id: templateId },
    include: {
      versions: {
        orderBy: { version: 'desc' },
        take: 1,
      },
      style: true,
    },
  });

  if (!template) {
    throw new NotFoundException('Template introuvable');
  }

  const latestVersion = template.versions[0];

  if (!latestVersion) {
    throw new BadRequestException(
      'Ce template ne possède aucune version.',
    );
  }

  const fileUrl = latestVersion.storagePath;

  if (!fileUrl.startsWith('https://')) {
    throw new BadRequestException(
      'Cette version utilise encore un ancien chemin local. Veuillez téléverser à nouveau le fichier.',
    );
  }

  let response: Response;

  try {
    response = await fetch(fileUrl);
  } catch (error) {
    console.error('Erreur lors de la lecture du template Blob:', error);

    throw new BadRequestException(
      'Impossible de récupérer le fichier du template.',
    );
  }

  if (!response.ok) {
    throw new BadRequestException(
      `Impossible de lire le fichier Blob (HTTP ${response.status}).`,
    );
  }

  const source = await response.text();

  let compiled: Handlebars.TemplateDelegate;

  try {
    compiled = Handlebars.compile(source);
  } catch (error) {
    console.error('Erreur de compilation Handlebars:', error);

    throw new BadRequestException(
      'Impossible de compiler le template.',
    );
  }

  return compiled({
    template,
    style: template.style,
    company: {
      name: 'L.I.M.',
    },
    preview: true,
  });
}

}
