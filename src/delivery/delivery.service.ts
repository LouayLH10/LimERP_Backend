import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'src/prisma/prisma.service';
import { DeliveryStatus, Prisma } from 'src/generated/prisma/client';

import { CreateDeliveryDto } from './dto/create-delivery.dto';
import { UpdateDeliveryDto } from './dto/update-delivery.dto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as Handlebars from 'handlebars';
import * as nodemailer from 'nodemailer';
import * as puppeteer from 'puppeteer';
import { join } from 'node:path';

@Injectable()
export class DeliveryService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  // =======================================================
  // CREATE DELIVERY
  // =======================================================

async create(
  orderId: string,
  createDeliveryDto: CreateDeliveryDto,
) {
  const { lines, notes } = createDeliveryDto;

  // =======================================================
  // 1. Vérifier les lignes
  // =======================================================
  if (!lines || lines.length === 0) {
    throw new BadRequestException(
      'A delivery must contain at least one line',
    );
  }

  // =======================================================
  // 2. Récupérer la commande
  // =======================================================
  const order = await this.prisma.order.findUnique({
    where: {
      id: orderId,
    },
    include: {
      client: true,
      project: true,
      lines: true,
    },
  });

  if (!order) {
    throw new NotFoundException(
      'Order not found',
    );
  }
console.log(order)
  // =======================================================
  // 3. Vérifier le statut de la commande
  // =======================================================
  if (order.status !== 'CONFIRMED') {
    throw new BadRequestException(
      'Only confirmed orders can be delivered',
    );
  }

  // =======================================================
  // 4. Récupérer les livraisons précédentes
  // =======================================================
  const previousDeliveries =
    await this.prisma.delivery.findMany({
      where: {
        orderId,
      
      },
      include: {
        lines: true,
      },
    });

  // =======================================================
  // 5. Calculer les quantités déjà livrées
  // =======================================================
  const deliveredQuantities =
    new Map<string, Prisma.Decimal>();

  for (const delivery of previousDeliveries) {
    for (const line of delivery.lines) {
      const current =
        deliveredQuantities.get(
          line.description,
        ) ?? new Prisma.Decimal(0);

      deliveredQuantities.set(
        line.description,
        current.add(line.quantity),
      );
    }
  }

  // =======================================================
  // 6. Vérifier et préparer les lignes
  // =======================================================
  const calculatedLines: {
    description: string;
    quantity: Prisma.Decimal;
  }[] = [];

  for (const line of lines) {
    const orderLine = order.lines.find(
      (orderLine) =>
        orderLine.description === line.description,
    );

    if (!orderLine) {
      throw new BadRequestException(
        `The delivery line "${line.description}" does not exist in the order`,
      );
    }

    const deliveryQuantity =
      new Prisma.Decimal(line.quantity);

    const alreadyDelivered =
      deliveredQuantities.get(
        line.description,
      ) ?? new Prisma.Decimal(0);

    const orderedQuantity =
      new Prisma.Decimal(orderLine.quantity);

    const remainingQuantity =
      orderedQuantity.sub(alreadyDelivered);

    if (
      deliveryQuantity.greaterThan(
        remainingQuantity,
      )
    ) {
      throw new BadRequestException(
        `Cannot deliver ${deliveryQuantity.toString()} of "${line.description}". Remaining quantity: ${remainingQuantity.toString()}`,
      );
    }

    calculatedLines.push({
      description: line.description,
      quantity: deliveryQuantity,
    });
  }

  // =======================================================
  // 7. Générer le numéro du BL
  // =======================================================
  const deliveryNumber =
    await this.generateDeliveryNumber();

  // =======================================================
  // 8. Créer le bon de livraison
  // =======================================================
  return this.prisma.$transaction(
    async (tx) => {
      const delivery =
        await tx.delivery.create({
          data: {
            number: deliveryNumber,

            deliveryDate: new Date(),

            status: 'DRAFT',

            notes: notes ?? null,

            client: {
              connect: {
                id: order.clientId,
              },
            },

            ...(order.projectId
              ? {
                  project: {
                    connect: {
                      id: order.projectId,
                    },
                  },
                }
              : {}),

            order: {
              connect: {
                id: order.id,
              },
            },

            lines: {
              create: calculatedLines,
            },
          },

          include: {
            client: true,
            project: true,
            order: true,
            lines: true,
          },
        });
  await tx.order.update({
          where: {
            id: order.id,
          },
          data: {
            status: 'TRANSFORMED',
          },
        });
      return delivery;
    },
  );
  
}

  // =======================================================
  // FIND ALL
  // =======================================================

  async findAll() {
    return this.prisma.delivery.findMany({
      orderBy: {
        createdAt: 'desc',
      },

      include: {
        client: true,

        project: true,

        order: {
          select: {
            id: true,
            number: true,
            status: true,
          },
        },

        lines: true,
      },
    });
  }

  // =======================================================
  // FIND ONE
  // =======================================================

  async findOne(id: string) {
    const delivery =
      await this.prisma.delivery.findUnique({
        where: {
          id,
        },

        include: {
          client: true,

          project: true,

          order: {
            select: {
              id: true,
              number: true,
              status: true,
              clientId: true,
              projectId: true,
            },
          },

          lines: true,
        },
      });

    if (!delivery) {
      throw new NotFoundException(
        'Delivery not found',
      );
    }

    return delivery;
  }

  // =======================================================
  // UPDATE DELIVERY
  // =======================================================

  async update(
    id: string,
    updateDeliveryDto: UpdateDeliveryDto,
  ) {
    const {
      clientId,
      projectId,
      orderId,
      deliveryDate,
      notes,
      lines,
      ...data
    } = updateDeliveryDto;

    // =======================================================
    // 1. Vérifier le BL
    // =======================================================

    const delivery =
      await this.prisma.delivery.findUnique({
        where: {
          id,
        },

        include: {
          lines: true,
        },
      });

    if (!delivery) {
      throw new NotFoundException(
        'Delivery not found',
      );
    }

    // =======================================================
    // 2. Seuls les BL DRAFT peuvent être modifiés
    // =======================================================

    if (delivery.status !== 'DRAFT') {
      throw new BadRequestException(
        'Only draft deliveries can be modified',
      );
    }

    // =======================================================
    // 3. Déterminer les valeurs finales
    // =======================================================

    const finalClientId =
      clientId !== undefined
        ? clientId
        : delivery.clientId;

    const finalOrderId =
      orderId !== undefined
        ? orderId
        : delivery.orderId;

    const finalProjectId =
      projectId !== undefined
        ? projectId
        : delivery.projectId;

    // =======================================================
    // 4. Vérifier le client
    // =======================================================

    const client =
      await this.prisma.client.findUnique({
        where: {
          id: finalClientId,
        },
      });

    if (!client) {
      throw new NotFoundException(
        'Client not found',
      );
    }

    // =======================================================
    // 5. Vérifier la commande
    // =======================================================

    if (!finalOrderId) {
      throw new BadRequestException(
        'A delivery must be linked to an order',
      );
    }

    const order =
      await this.prisma.order.findUnique({
        where: {
          id: finalOrderId,
        },

        include: {
          lines: true,
        },
      });

    if (!order) {
      throw new NotFoundException(
        'Order not found',
      );
    }

    if (order.status !== 'CONFIRMED') {
      throw new BadRequestException(
        'Only confirmed orders can have deliveries',
      );
    }

    if (order.clientId !== finalClientId) {
      throw new BadRequestException(
        'The selected client does not belong to this order',
      );
    }

    // =======================================================
    // 6. Vérifier le projet
    // =======================================================

    if (finalProjectId !== undefined && finalProjectId !== null) {
      const project =
        await this.prisma.project.findUnique({
          where: {
            id: finalProjectId,
          },
        });

      if (!project) {
        throw new NotFoundException(
          'Project not found',
        );
      }

      if (project.clientId !== finalClientId) {
        throw new BadRequestException(
          'The selected project does not belong to the selected client',
        );
      }

      if (
        order.projectId !== null &&
        order.projectId !== finalProjectId
      ) {
        throw new BadRequestException(
          'The selected project does not belong to this order',
        );
      }
    }

    // =======================================================
    // 7. Préparer les données générales
    // =======================================================

    const updateData: any = {
      ...data,
    };

    if (clientId !== undefined) {
      updateData.client = {
        connect: {
          id: clientId,
        },
      };
    }

    if (projectId !== undefined) {
      if (projectId === null) {
        updateData.project = {
          disconnect: true,
        };
      } else {
        updateData.project = {
          connect: {
            id: projectId,
          },
        };
      }
    }

    if (orderId !== undefined) {
      updateData.order = {
        connect: {
          id: orderId,
        },
      };
    }

    if (deliveryDate !== undefined) {
      updateData.deliveryDate =
        new Date(deliveryDate);
    }

    if (notes !== undefined) {
      updateData.notes = notes;
    }

    // =======================================================
    // 8. Recalculer les lignes
    // =======================================================

    let calculatedLines: {
      description: string;
      quantity: Prisma.Decimal;
    }[] = [];

    if (lines !== undefined) {
      if (lines.length === 0) {
        throw new BadRequestException(
          'A delivery must contain at least one line',
        );
      }

      // ---------------------------------------------------
      // Récupérer les autres BL de la même commande
      // ---------------------------------------------------

      const previousDeliveries =
        await this.prisma.delivery.findMany({
          where: {
            orderId: finalOrderId,
            NOT: {
              id,
            },
          },

          include: {
            lines: true,
          },
        });

      // ---------------------------------------------------
      // Quantités déjà livrées
      // ---------------------------------------------------

      const deliveredQuantities =
        new Map<string, Prisma.Decimal>();

      for (const previousDelivery of previousDeliveries) {
        for (const line of previousDelivery.lines) {
          const current =
            deliveredQuantities.get(
              line.description,
            ) ?? new Prisma.Decimal(0);

          deliveredQuantities.set(
            line.description,
            current.add(line.quantity),
          );
        }
      }

      // ---------------------------------------------------
      // Vérifier les nouvelles lignes
      // ---------------------------------------------------

      for (const line of lines) {
        const orderLine = order.lines.find(
          (orderLine) =>
            orderLine.description ===
            line.description,
        );

        if (!orderLine) {
          throw new BadRequestException(
            `The delivery line "${line.description}" does not exist in the order`,
          );
        }

        const quantity =
          new Prisma.Decimal(line.quantity);

        const alreadyDelivered =
          deliveredQuantities.get(
            line.description,
          ) ?? new Prisma.Decimal(0);

        const orderedQuantity =
          new Prisma.Decimal(
            orderLine.quantity,
          );

        const remainingQuantity =
          orderedQuantity.sub(
            alreadyDelivered,
          );

        if (
          quantity.greaterThan(
            remainingQuantity,
          )
        ) {
          throw new BadRequestException(
            `Cannot deliver ${quantity.toString()} of "${line.description}". Remaining quantity: ${remainingQuantity.toString()}`,
          );
        }

        calculatedLines.push({
          description: line.description,
          quantity,
        });
      }
    }

    // =======================================================
    // 9. Transaction
    // =======================================================

    return this.prisma.$transaction(
      async (tx) => {
        // ---------------------------------------------------
        // Remplacer les lignes
        // ---------------------------------------------------

        if (lines !== undefined) {
          await tx.deliveryLine.deleteMany({
            where: {
              deliveryId: id,
            },
          });

          await tx.deliveryLine.createMany({
            data: calculatedLines.map(
              (line) => ({
                deliveryId: id,
                description:
                  line.description,
                quantity: line.quantity,
              }),
            ),
        });
        }

        // ---------------------------------------------------
        // Mettre à jour le BL
        // ---------------------------------------------------

        return tx.delivery.update({
          where: {
            id,
          },

          data: updateData,

          include: {
            client: true,
            project: true,
            order: true,
            lines: true,
          },
        });
      },
    );
  }

  // =======================================================
  // CONFIRM DELIVERY
  // =======================================================

  async confirm(id: string) {
    const delivery =
      await this.prisma.delivery.findUnique({
        where: {
          id,
        },

        include: {
          lines: true,
        },
      });

    if (!delivery) {
      throw new NotFoundException(
        'Delivery not found',
      );
    }

    // =======================================================
    // Vérifier le statut
    // =======================================================

    if (delivery.status !== 'DRAFT') {
      throw new BadRequestException(
        'Only draft deliveries can be confirmed',
      );
    }

    // =======================================================
    // Vérifier les lignes
    // =======================================================

    if (delivery.lines.length === 0) {
      throw new BadRequestException(
        'A delivery must contain at least one line',
      );
    }

    // =======================================================
    // Confirmer
    // =======================================================

    return this.prisma.delivery.update({
      where: {
        id,
      },

      data: {
        status: 'CONFIRMED',
      },

      include: {
        client: true,
        project: true,
        order: true,
        lines: true,
      },
    });
  }

  // =======================================================
  // DELETE
  // =======================================================

  async remove(id: string) {
    const delivery =
      await this.prisma.delivery.findUnique({
        where: {
          id,
        },
      });

    if (!delivery) {
      throw new NotFoundException(
        'Delivery not found',
      );
    }

    // =======================================================
    // Seuls les BL DRAFT peuvent être supprimés
    // =======================================================

    if (delivery.status !== 'DRAFT') {
      throw new BadRequestException(
        'Only draft deliveries can be deleted',
      );
    }

    return this.prisma.delivery.delete({
      where: {
        id,
      },
    });
  }

  // =======================================================
  // GENERATE DELIVERY NUMBER
  // Example: BL-2026-0001
  // =======================================================

  private async generateDeliveryNumber(): Promise<string> {
    const year = new Date().getFullYear();

    const prefix = `BL-${year}-`;

    const lastDelivery =
      await this.prisma.delivery.findFirst({
        where: {
          number: {
            startsWith: prefix,
          },
        },

        orderBy: {
          number: 'desc',
        },
      });

    let nextNumber = 1;

    if (lastDelivery) {
      const lastNumber = parseInt(
        lastDelivery.number.replace(
          prefix,
          '',
        ),
        10,
      );

      if (!Number.isNaN(lastNumber)) {
        nextNumber = lastNumber + 1;
      }
    }

    return (
      `${prefix}` +
      String(nextNumber).padStart(4, '0')
    );
  }
  async changeStatus(
  id: string,
  cancelled = false,
) {
  const delivery =
    await this.prisma.delivery.findUnique({
      where: {
        id,
      },
    });

  if (!delivery) {
    throw new NotFoundException(
      'Delivery not found',
    );
  }

  // =======================================================
  // Annulation
  // =======================================================
  if (cancelled) {
    if (
      delivery.status === 'DELIVERED' ||
      delivery.status === 'CANCELLED'
    ) {
      throw new BadRequestException(
        `A delivery with status ${delivery.status} cannot be cancelled`,
      );
    }

    return this.prisma.delivery.update({
      where: {
        id,
      },
      data: {
        status: 'CANCELLED',
      },
      include: {
        client: true,
        project: true,
        order: true,
        lines: true,
      },
    });
  }

  // =======================================================
  // Passage à l'état suivant
  // =======================================================
  let nextStatus: DeliveryStatus;

  switch (delivery.status) {
    case 'DRAFT':
      nextStatus = 'CONFIRMED';
      break;

    case 'CONFIRMED':
      nextStatus = 'DELIVERED';
      break;

    case 'DELIVERED':
      throw new BadRequestException(
        'This delivery has already been delivered',
      );

    case 'CANCELLED':
      throw new BadRequestException(
        'This delivery has been cancelled',
      );

    default:
      throw new BadRequestException(
        'Invalid delivery status',
      );
  }

  return this.prisma.delivery.update({
    where: {
      id,
    },
    data: {
      status: nextStatus,
    },
    include: {
      client: true,
      project: true,
      order: true,
      lines: true,
    },
  });
}

  // =======================================================
  // GENERATE DELIVERY PDF
  // =======================================================

 async generatePdf(id: string): Promise<Buffer> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id },
      include: {
        client: true,
        project: true,
        order: true,
        lines: true,
      },
    });

    if (!delivery) {
      throw new NotFoundException('Bon de livraison introuvable.');
    }

    if (!delivery.lines.length) {
      throw new BadRequestException(
        'Impossible de générer un bon de livraison sans lignes.',
      );
    }

    const template = await this.prisma.documentTemplate.findFirst({
      where: {
        type: 'DELIVERY',
        isDefault: true,
        isActive: true,
      },
      include: {
        versions: {
          orderBy: { version: 'desc' },
          take: 1,
        },
        style: true,
      },
    });

    if (!template) {
      throw new ConflictException(
        'Aucun modèle de bon de livraison actif défini par défaut.',
      );
    }

    const version = template.versions[0];

    if (!version) {
      throw new ConflictException(
        'Le modèle de bon de livraison ne possède aucune version.',
      );
    }

    const templatePath = path.isAbsolute(version.storagePath)
      ? version.storagePath
      : path.resolve(process.cwd(), version.storagePath);

    let templateSource: string;

    try {
      templateSource = await fs.readFile(templatePath, 'utf8');
    } catch {
      throw new ConflictException(
        'Le fichier du modèle de bon de livraison est introuvable.',
      );
    }

    const formatQuantity = (
      value: Prisma.Decimal | number | string | null,
    ): string =>
      Number(value ?? 0).toLocaleString('fr-TN', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 3,
      });

    const templateData = {
      delivery: {
        id: delivery.id,
        number: delivery.number,
        deliveryDate: delivery.deliveryDate.toLocaleDateString('fr-FR'),
        status: delivery.status,
        notes: delivery.notes ?? '',
      },
      client: delivery.client,
      project: delivery.project,
      order: delivery.order,
      lines: delivery.lines.map((line) => ({
        description: line.description,
        quantity: formatQuantity(line.quantity),
      })),
      style: template.style,
      generatedAt: new Date().toLocaleDateString('fr-FR'),
    };

    const html = Handlebars.compile(templateSource)(templateData);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();

      await page.setContent(html, { waitUntil: 'load' });

      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
        margin: {
          top: '12mm',
          right: '12mm',
          bottom: '12mm',
          left: '12mm',
        },
      });

      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  // =======================================================
  // SEND DELIVERY PDF BY EMAIL
  // =======================================================

  async sendEmail(id: string) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id },
      include: {
        client: true,
        project: true,
        order: true,
        lines: true,
      },
    });

    if (!delivery) {
      throw new NotFoundException('Delivery not found');
    }

    const recipient = delivery.client?.email;

    if (!recipient) {
      throw new BadRequestException(
        'The client does not have an email address',
      );
    }

    if (!delivery.lines.length) {
      throw new BadRequestException(
        'Cannot send a delivery without lines',
      );
    }

    const isProduction = process.env.NODE_ENV === 'production';

    const host = isProduction
      ? 'smtp-relay.brevo.com'
      : 'smtp.gmail.com';

    const user = isProduction
      ? process.env.BREVO_LOGIN
      : process.env.MAIL_USER;

    const pass = isProduction
      ? process.env.BREVO_SMTP_KEY
      : process.env.PASS_MAIL;

    if (!user || !pass) {
      throw new BadRequestException(
        'Email configuration is incomplete. Check your SMTP environment variables.',
      );
    }

    const transporter = nodemailer.createTransport({
      host,
      port: 587,
      secure: false,
      auth: { user, pass },
    });

    const pdf = await this.generatePdf(id);

    const safeNumber = delivery.number.replace(
      /[^a-zA-Z0-9_-]/g,
      '_',
    );

    await transporter.sendMail({
      from: user,
      to: recipient,
      subject: `Bon de livraison ${delivery.number}`,
      text: [
        `Bonjour ${delivery.client.companyName  || ''},`,
        '',
        `Veuillez trouver en pièce jointe le bon de livraison ${delivery.number}.`,
        '',
        'Cordialement,',
        'L.I.M.',
      ].join('\n'),
      html: `
        <div style="font-family: Arial, sans-serif; color: #334155; line-height: 1.6;">
          <p>Bonjour ${escapeHtml(
            delivery.client.companyName  || '',
          )},</p>
          <p>
            Veuillez trouver en pièce jointe le bon de livraison
            <strong>${escapeHtml(delivery.number)}</strong>.
          </p>
          <p>Cordialement,<br><strong>L.I.M.</strong></p>
        </div>
      `,
      attachments: [
        {
          filename: `bon-livraison-${safeNumber}.pdf`,
          content: pdf,
          contentType: 'application/pdf',
        },
      ],
    });

    return {
      success: true,
      message: 'Delivery note sent successfully',
      deliveryNumber: delivery.number,
      recipient,
    };
  }

}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

