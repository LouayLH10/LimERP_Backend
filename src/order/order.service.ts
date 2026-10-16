import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'src/prisma/prisma.service';
import { OrderStatus, Prisma } from 'src/generated/prisma/client';

import { CreateOrderFromQuoteDto } from './dto/create-order.dto'; 
import { UpdateOrderDto } from './dto/update-order.dto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import Handlebars from 'handlebars';
import puppeteer from 'puppeteer';
import nodemailer from 'nodemailer';
@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  // =======================================================
  // CREATE ORDER FROM QUOTE
  // =======================================================

  async createFromQuote(
    quoteId: string,
    createOrderDto: CreateOrderFromQuoteDto,
  ) {
    const { lines, notes } = createOrderDto;

    // =======================================================
    // 1. Vérifier les lignes
    // =======================================================

    if (!lines || lines.length === 0) {
      throw new BadRequestException(
        'An order must contain at least one line',
      );
    }

    // =======================================================
    // 2. Récupérer le devis
    // =======================================================

    const quote = await this.prisma.quote.findUnique({
      where: {
        id: quoteId,
      },
      include: {
        client: true,
        project: true,
      },
    });

    if (!quote) {
      throw new NotFoundException(
        'Quote not found',
      );
    }

    // =======================================================
    // 3. Vérifier le statut du devis
    // =======================================================

    if (
      quote.status !== 'ACCEPTED' &&
      quote.status !== 'DRAFT'
    ) {
      throw new BadRequestException(
        'This quote cannot be transformed into an order',
      );
    }

    // =======================================================
    // 4. Vérifier qu'il n'existe pas déjà une commande
    //    provenant de ce devis
    // =======================================================

    const existingOrder =
      await this.prisma.order.findFirst({
        where: {
          quoteId,
        },
      });

    if (existingOrder) {
      throw new BadRequestException(
        'An order already exists for this quote',
      );
    }

    // =======================================================
    // 5. Calculer les lignes
    // =======================================================

    let subtotal = new Prisma.Decimal(0);
    let taxAmount = new Prisma.Decimal(0);

    const calculatedLines: {
      description: string;
      quantity: Prisma.Decimal;
      unitPrice: Prisma.Decimal;
      taxRate: Prisma.Decimal;
      total: Prisma.Decimal;
    }[] = [];

    for (const line of lines) {
      const quantity = new Prisma.Decimal(
        line.quantity,
      );

      const unitPrice = new Prisma.Decimal(
        line.unitPrice,
      );

      const taxRate = new Prisma.Decimal(
        line.taxRate,
      );

      // HT
      const lineSubtotal = quantity.mul(unitPrice);

      // TVA
      const lineTax = lineSubtotal
        .mul(taxRate)
        .div(100);

      // TTC
      const lineTotal = lineSubtotal.add(lineTax);

      subtotal = subtotal.add(lineSubtotal);
      taxAmount = taxAmount.add(lineTax);

      calculatedLines.push({
        description: line.description,
        quantity,
        unitPrice,
        taxRate,
        total: lineTotal,
      });
    }

    const total = subtotal.add(taxAmount);

    // =======================================================
    // 6. Générer le numéro de commande
    // =======================================================

    const orderNumber =
      await this.generateOrderNumber();

    // =======================================================
    // 7. Créer la commande
    // =======================================================

    return this.prisma.$transaction(
      async (tx) => {
        const order = await tx.order.create({
          data: {
            number: orderNumber,

            orderDate: new Date(),

            status: 'DRAFT',

            subtotal,
            taxAmount,
            total,

            notes: notes ?? quote.notes,

            client: {
              connect: {
                id: quote.clientId,
              },
            },

            ...(quote.projectId
              ? {
                  project: {
                    connect: {
                      id: quote.projectId,
                    },
                  },
                }
              : {}),

            quote: {
              connect: {
                id: quote.id,
              },
            },

            lines: {
              create: calculatedLines,
            },
          },

          include: {
            client: true,
            project: true,
            quote: true,
            lines: true,
          },
        });

        // ---------------------------------------------------
        // Marquer le devis comme transformé
        // ---------------------------------------------------

        await tx.quote.update({
          where: {
            id: quote.id,
          },
          data: {
            status: 'TRANSFORMED',
          },
        });

        return order;
      },
    );
  }

  // =======================================================
  // FIND ALL
  // =======================================================

  async findAll() {
    return this.prisma.order.findMany({
      orderBy: {
        createdAt: 'desc',
      },

      include: {
        client: true,
        project: true,

        quote: {
          select: {
            id: true,
            number: true,
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
    const order = await this.prisma.order.findUnique({
      where: {
        id,
      },

      include: {
        client: true,
        project: true,

        quote: {
          select: {
            id: true,
            number: true,
            status: true,
          },
        },

        lines: true,
      },
    });

    if (!order) {
      throw new NotFoundException(
        'Order not found',
      );
    }

    return order;
  }

  // =======================================================
  // UPDATE ORDER
  // =======================================================

  async update(
    id: string,
    updateOrderDto: UpdateOrderDto,
  ) {
    const {
      clientId,
      projectId,
      lines,
      orderDate,
      notes,
      ...data
    } = updateOrderDto;

    // =======================================================
    // 1. Vérifier la commande
    // =======================================================

    const order = await this.prisma.order.findUnique({
      where: {
        id,
      },
    });

    if (!order) {
      throw new NotFoundException(
        'Order not found',
      );
    }

    // =======================================================
    // 2. Empêcher la modification après confirmation
    // =======================================================

    if (
      order.status !== 'DRAFT'
    ) {
      throw new BadRequestException(
        'Only draft orders can be modified',
      );
    }

    // =======================================================
    // 3. Vérifier le client
    // =======================================================

    if (clientId !== undefined) {
      const client =
        await this.prisma.client.findUnique({
          where: {
            id: clientId,
          },
        });

      if (!client) {
        throw new NotFoundException(
          'Client not found',
        );
      }
    }

    // =======================================================
    // 4. Vérifier le projet
    // =======================================================

    if (
      projectId !== undefined &&
      projectId !== null
    ) {
      const project =
        await this.prisma.project.findUnique({
          where: {
            id: projectId,
          },
        });

      if (!project) {
        throw new NotFoundException(
          'Project not found',
        );
      }

      const finalClientId =
        clientId !== undefined
          ? clientId
          : order.clientId;

      if (
        project.clientId !== finalClientId
      ) {
        throw new BadRequestException(
          'The selected project does not belong to the selected client',
        );
      }
    }

    // =======================================================
    // 5. Préparer les données générales
    // =======================================================

    const updateData: any = {
      ...data,
    };

    // Client
    if (clientId !== undefined) {
      updateData.client = {
        connect: {
          id: clientId,
        },
      };
    }

    // Projet
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

    // Date
    if (orderDate !== undefined) {
      updateData.issueDate =
        new Date(orderDate);
    }

    // =======================================================
    // 6. Recalculer les lignes si elles sont fournies
    // =======================================================

    let calculatedLines:
      {
        description: string;
        quantity: Prisma.Decimal;
        unitPrice: Prisma.Decimal;
        taxRate: Prisma.Decimal;
        total: Prisma.Decimal;
      }[] = [];

    let subtotal = order.subtotal;
    let taxAmount = order.taxAmount;
    let total = order.total;

    if (lines !== undefined) {
      if (lines.length === 0) {
        throw new BadRequestException(
          'An order must contain at least one line',
        );
      }

      subtotal = new Prisma.Decimal(0);
      taxAmount = new Prisma.Decimal(0);

      for (const line of lines) {
        const quantity =
          new Prisma.Decimal(
            line.quantity,
          );

        const unitPrice =
          new Prisma.Decimal(
            line.unitPrice,
          );

        const taxRate =
          new Prisma.Decimal(
            line.taxRate,
          );

        const lineSubtotal =
          quantity.mul(unitPrice);

        const lineTax =
          lineSubtotal
            .mul(taxRate)
            .div(100);

        const lineTotal =
          lineSubtotal.add(lineTax);

        subtotal =
          subtotal.add(lineSubtotal);

        taxAmount =
          taxAmount.add(lineTax);

        calculatedLines.push({
          description: line.description,
          quantity,
          unitPrice,
          taxRate,
          total: lineTotal,
        });
      }

      total = subtotal.add(taxAmount);

      updateData.subtotal = subtotal;
      updateData.taxAmount = taxAmount;
      updateData.total = total;
    }

    // =======================================================
    // 7. Transaction
    // =======================================================

    return this.prisma.$transaction(
      async (tx) => {
        // Remplacer les lignes si elles sont fournies
        if (lines !== undefined) {
          await tx.orderLine.deleteMany({
            where: {
              orderId: id,
            },
          });

          await tx.orderLine.createMany({
            data: calculatedLines.map(
              (line) => ({
                orderId: id,
                description:
                  line.description,
                quantity:
                  line.quantity,
                unitPrice:
                  line.unitPrice,
                taxRate:
                  line.taxRate,
                total:
                  line.total,
              }),
            ),
          });
        }

        return tx.order.update({
          where: {
            id,
          },

          data: updateData,

          include: {
            client: true,
            project: true,
            quote: true,
            lines: true,
          },
        });
      },
    );
  }

  // =======================================================
  // CONFIRM ORDER
  // =======================================================

  async confirm(id: string) {
    const order =
      await this.prisma.order.findUnique({
        where: {
          id,
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

    if (order.status !== 'DRAFT') {
      throw new BadRequestException(
        'Only draft orders can be confirmed',
      );
    }

    if (order.lines.length === 0) {
      throw new BadRequestException(
        'An order must contain at least one line',
      );
    }

    return this.prisma.order.update({
      where: {
        id,
      },

      data: {
        status: 'CONFIRMED',
      },

      include: {
        client: true,
        project: true,
        quote: true,
        lines: true,
      },
    });
  }

  // =======================================================
  // DELETE
  // =======================================================

  async remove(id: string) {
    const order =
      await this.prisma.order.findUnique({
        where: {
          id,
        },
      });

    if (!order) {
      throw new NotFoundException(
        'Order not found',
      );
    }

    // Seulement une commande DRAFT peut être supprimée
    if (order.status !== 'DRAFT') {
      throw new BadRequestException(
        'Only draft orders can be deleted',
      );
    }

    return this.prisma.order.delete({
      where: {
        id,
      },
    });
  }

  // =======================================================
  // GENERATE ORDER NUMBER
  // Example: CMD-2026-0001
  // =======================================================

  private async generateOrderNumber(): Promise<string> {
    const year =
      new Date().getFullYear();

    const prefix =
      `CMD-${year}-`;

    const lastOrder =
      await this.prisma.order.findFirst({
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

    if (lastOrder) {
      const lastNumber =
        parseInt(
          lastOrder.number.replace(
            prefix,
            '',
          ),
          10,
        );

      if (!Number.isNaN(lastNumber)) {
        nextNumber =
          lastNumber + 1;
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
  const order = await this.prisma.order.findUnique({
    where: {
      id,
    },
  });

  if (!order) {
    throw new NotFoundException(
      'Order not found',
    );
  }

  // =======================================================
  // Annulation
  // =======================================================
  console.log(cancelled)
  if (cancelled===true) {
    if (
      order.status === 'COMPLETED' ||
      order.status === 'TRANSFORMED' ||
      order.status === 'CANCELLED'
    ) {
      throw new BadRequestException(
        `An order with status ${order.status} cannot be cancelled`,
      );
    }

    return this.prisma.order.update({
      where: {
        id,
      },
      data: {
        status: 'CANCELLED',
      },
      include: {
        client: true,
        project: true,
        quote: true,
        lines: true,
      },
    });
  }

  // =======================================================
  // Passage à l'état suivant
  // =======================================================
  let nextStatus: OrderStatus;

  switch (order.status) {
    case 'DRAFT':
      nextStatus = 'CONFIRMED';
      break;


    case 'IN_PROGRESS':
      nextStatus = 'COMPLETED';
      break;
  case 'COMPLETED':
      nextStatus = 'CONFIRMED';
      break;

    case 'CONFIRMED':
      throw new BadRequestException(
        'This order is already confirmed',
      );

    case 'TRANSFORMED':
      throw new BadRequestException(
        'This order has already been transformed',
      );

    case 'CANCELLED':
      throw new BadRequestException(
        'This order has been cancelled',
      );

    default:
      throw new BadRequestException(
        'Invalid order status',
      );
  }

  return this.prisma.order.update({
    where: {
      id,
    },
    data: {
      status: nextStatus,
    },
    include: {
      client: true,
      project: true,
      quote: true,
      lines: true,
    },
  });
}
async generatePdf(id: string): Promise<Buffer> {
  const order = await this.prisma.order.findUnique({
    where: { id },
    include: {
      client: true,
      project: true,
      quote: true,
      lines: true,
    },
  });

  if (!order) {
    throw new NotFoundException('Commande introuvable.');
  }

  const template = await this.prisma.documentTemplate.findFirst({
    where: {
      type: 'ORDER',
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
      'Aucun modèle de commande actif défini par défaut.',
    );
  }

  const version = template.versions[0];

  if (!version) {
    throw new ConflictException(
      'Le modèle de commande ne possède aucune version.',
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
      'Le fichier du modèle de commande est introuvable.',
    );
  }

  const formatAmount = (
    value: Prisma.Decimal | number | string | null,
  ): string =>
    Number(value ?? 0).toLocaleString('fr-TN', {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    });

  const templateData = {
    order: {
      id: order.id,
      number: order.number,
      orderDate: order.orderDate.toLocaleDateString('fr-FR'),
      status: order.status,
      notes: order.notes ?? '',
      subtotal: formatAmount(order.subtotal),
      taxAmount: formatAmount(order.taxAmount),
      total: formatAmount(order.total),
    },
    client: order.client,
    project: order.project,
    quote: order.quote,
    lines: order.lines.map((line) => ({
      description: line.description,
      quantity: formatAmount(line.quantity),
      unitPrice: formatAmount(line.unitPrice),
      taxRate: formatAmount(line.taxRate),
      total: formatAmount(line.total),
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

async sendEmail(id: string) {
  // 1. Récupérer le bon de commande et les informations du client
  const order = await this.findOne(id);

  const recipientEmail = order.client.email?.trim();

  if (!recipientEmail) {
    throw new BadRequestException(
      "Le client ne possède pas d'adresse e-mail.",
    );
  }

  // 2. Vérifier la configuration SMTP
  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_SECURE,
    SMTP_USER,
    SMTP_PASS,
    SMTP_FROM,
  } = process.env;

  if (
    !SMTP_HOST ||
    !SMTP_PORT ||
    !SMTP_USER ||
    !SMTP_PASS ||
    !SMTP_FROM
  ) {
    throw new InternalServerErrorException(
      'La configuration SMTP est incomplète.',
    );
  }

  // 3. Générer le PDF du bon de commande
  const pdf = await this.generatePdf(id);

  // 4. Préparer les données de l'e-mail
  const escapeHtml = (value: unknown): string =>
    String(value ?? '').replace(/[&<>"']/g, (char) => {
      const entities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      };

      return entities[char];
    });

  const clientName = escapeHtml(
    order.client.companyName ?? 'Client',
  );

  const orderNumber = escapeHtml(order.number);

  const orderDate = escapeHtml(
    new Date(order.orderDate).toLocaleDateString('fr-FR'),
  );

  const orderTotal = `${Number(order.total).toLocaleString('fr-TN', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  })} TND`;

  const safeOrderTotal = escapeHtml(orderTotal);

  const filename = `bon-commande-${order.number}.pdf`;

  const html = `
    <!DOCTYPE html>
    <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Votre bon de commande L.I.M.</title>
      </head>

      <body style="margin:0;padding:0;background:#f4f6f8;
        font-family:Arial,Helvetica,sans-serif;color:#1f2937;">

        <div style="padding:32px 12px;">
          <div style="max-width:600px;margin:0 auto;background:#ffffff;
            border-radius:10px;overflow:hidden;">

            <div style="background:#1f2937;padding:24px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:23px;">
                L.I.M. — Louay Industry &amp; Maintenance
              </h1>
            </div>

            <div style="padding:30px 26px;">
              <h2 style="margin-top:0;font-size:21px;">
                Votre bon de commande est prêt
              </h2>

              <p>Bonjour ${clientName},</p>

              <p>
                Nous vous remercions pour votre confiance.
                Veuillez trouver votre bon de commande en pièce jointe.
              </p>

              <div style="background:#f4f6f8;border-radius:8px;
                padding:18px;margin:24px 0;">

                <p style="margin:0 0 12px;">
                  <strong>Numéro de commande :</strong>
                  ${orderNumber}
                </p>

                <p style="margin:0 0 12px;">
                  <strong>Date :</strong> ${orderDate}
                </p>

                <p style="margin:0 0 12px;">
                  <strong>Statut :</strong>
                  ${escapeHtml(order.status)}
                </p>

                <p style="margin:0;">
                  <strong>Montant total :</strong>
                  ${safeOrderTotal}
                </p>
              </div>

              <p>
                <strong>Pièce jointe :</strong>
                ${escapeHtml(filename)}
              </p>

              <p>
                Pour toute question ou information complémentaire,
                n'hésitez pas à nous contacter.
              </p>

              <p style="margin-bottom:0;">
                Cordialement,<br>
                <strong>L'équipe L.I.M.</strong>
              </p>
            </div>

            <div style="background:#f4f6f8;padding:18px 24px;
              text-align:center;color:#6b7280;font-size:12px;">
              L.I.M. — Louay Industry &amp; Maintenance
            </div>

          </div>
        </div>
      </body>
    </html>
  `;

  // 5. Configurer Nodemailer
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: SMTP_SECURE === 'true',
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  // 6. Envoyer l'e-mail avec le PDF en pièce jointe
  try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to: "hcinlouay@gmail.com",
      subject: `Votre bon de commande ${order.number} — L.I.M.`,
      text:
        `Bonjour ${order.client.companyName ?? 'Client'},\n\n` +
        `Veuillez trouver ci-joint le bon de commande ${order.number}.\n` +
        `Date : ${orderDate}\n` +
        `Montant total : ${orderTotal}.\n\n` +
        `Cordialement,\nL'équipe L.I.M.`,
      html,
      attachments: [
        {
          filename,
          content: pdf,
          contentType: 'application/pdf',
          contentDisposition: 'attachment',
        },
      ],
    });
  } catch (error) {
    console.error('SMTP order sending failed:', error);

    throw new InternalServerErrorException(
      "L'envoi du bon de commande par e-mail a échoué. Vérifiez la configuration SMTP.",
    );
  }

  // 7. Retourner le résultat de l'envoi
  return {
    success: true,
    message: 'Le bon de commande a été envoyé par e-mail.',
    orderNumber: order.number,
    recipient: recipientEmail,
  };
}

}
