import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';

import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as Handlebars from 'handlebars';
import * as nodemailer from 'nodemailer';
import * as puppeteer from 'puppeteer';
@Injectable()
export class InvoiceService {
  constructor(private readonly prisma: PrismaService) {}

  // ============================================================
  // CREATE INVOICE FROM DELIVERY
  // ============================================================

  async create(
    deliveryId: string,
    createInvoiceDto: CreateInvoiceDto,
  ) {
    const delivery = await this.prisma.delivery.findUnique({
      where: {
        id: deliveryId,
      },
      include: {
        client: true,
        project: true,
        order: {
          include: {
            lines: true,
          },
        },
        lines: true,
      },
    });

    if (!delivery) {
      throw new NotFoundException('Delivery not found');
    }

    // ----------------------------------------------------------
    // Delivery must be confirmed/delivered
    // ----------------------------------------------------------

    if (
      delivery.status !== 'CONFIRMED' &&
      delivery.status !== 'DELIVERED'
    ) {
      throw new BadRequestException(
        'Only confirmed or delivered deliveries can be invoiced',
      );
    }

    if (!delivery.order) {
      throw new BadRequestException(
        'This delivery is not linked to an order',
      );
    }

    if (delivery.lines.length === 0) {
      throw new BadRequestException(
        'Cannot create an invoice from a delivery without lines',
      );
    }

    // ----------------------------------------------------------
    // Prevent duplicate invoice for the same delivery
    //
    // IMPORTANT:
    // Your current Invoice model does NOT contain deliveryId.
    // Therefore we use orderId + invoice lines to determine
    // whether the delivery was already invoiced.
    //
    // This is not perfect and is explained below.
    // ----------------------------------------------------------

    const existingInvoices = await this.prisma.invoice.findMany({
      where: {
        orderId: delivery.order.id,
      },
      include: {
        lines: true,
      },
    });

    // ----------------------------------------------------------
    // Build invoice lines
    // ----------------------------------------------------------

    const calculatedLines: {
      description: string;
      quantity: Prisma.Decimal;
      unitPrice: Prisma.Decimal;
      taxRate: Prisma.Decimal;
      total: Prisma.Decimal;
    }[] = [];

    let subtotal = new Prisma.Decimal(0);
    let taxAmount = new Prisma.Decimal(0);

    for (const deliveryLine of delivery.lines) {
      // Find corresponding order line by description
      const orderLine = delivery.order.lines.find(
        (line) =>
          line.description.trim().toLowerCase() ===
          deliveryLine.description.trim().toLowerCase(),
      );

      if (!orderLine) {
        throw new BadRequestException(
          `No matching order line found for "${deliveryLine.description}"`,
        );
      }

      const quantity = new Prisma.Decimal(
        deliveryLine.quantity,
      );

      const unitPrice = new Prisma.Decimal(
        orderLine.unitPrice,
      );

      const taxRate = new Prisma.Decimal(
        orderLine.taxRate,
      );

      const lineSubtotal = quantity.mul(unitPrice);

      const lineTax = lineSubtotal
        .mul(taxRate)
        .div(100);

      const lineTotal = lineSubtotal.add(lineTax);

      calculatedLines.push({
        description: orderLine.description,
        quantity,
        unitPrice,
        taxRate,
        total: lineTotal,
      });

      subtotal = subtotal.add(lineSubtotal);
      taxAmount = taxAmount.add(lineTax);
    }

    const total = subtotal.add(taxAmount);

    // ----------------------------------------------------------
    // Generate invoice number
    // ----------------------------------------------------------

    const invoiceNumber =
      await this.generateInvoiceNumber();

    // ----------------------------------------------------------
    // Create invoice
    // ----------------------------------------------------------

    return this.prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          number: invoiceNumber,

          issueDate: new Date(),

          ...(createInvoiceDto.dueDate
            ? {
                dueDate: new Date(
                  createInvoiceDto.dueDate,
                ),
              }
            : {}),

          status: 'DRAFT',

          subtotal,
          taxAmount,
          total,

          paidAmount: new Prisma.Decimal(0),

          notes: createInvoiceDto.notes ?? null,

          client: {
            connect: {
              id: delivery.clientId,
            },
          },

          ...(delivery.projectId
            ? {
                project: {
                  connect: {
                    id: delivery.projectId,
                  },
                },
              }
            : {}),

          order: {
            connect: {
              id: delivery.order?.id,
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

      return invoice;
    });
  }

  // ============================================================
  // FIND ALL
  // ============================================================

  async findAll() {
    return this.prisma.invoice.findMany({
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
        creditNotes: true,
        attachments: true,
      },
    });
  }

  // ============================================================
  // FIND ONE
  // ============================================================

  async findOne(id: string) {
    const invoice =
      await this.prisma.invoice.findUnique({
        where: {
          id,
        },

        include: {
          client: true,
          project: true,

          order: {
            include: {
              lines: true,
            },
          },

          lines: true,
          creditNotes: true,
          attachments: true,
        },
      });

    if (!invoice) {
      throw new NotFoundException(
        'Invoice not found',
      );
    }

    return invoice;
  }

  // ============================================================
  // UPDATE
  // ============================================================

  async update(
    id: string,
    updateInvoiceDto: UpdateInvoiceDto,
  ) {
    const invoice =
      await this.prisma.invoice.findUnique({
        where: {
          id,
        },

        include: {
          lines: true,
        },
      });

    if (!invoice) {
      throw new NotFoundException(
        'Invoice not found',
      );
    }

    // Only DRAFT invoices can be modified
    if (invoice.status !== 'DRAFT') {
      throw new BadRequestException(
        `Invoice with status ${invoice.status} cannot be modified`,
      );
    }

    const data: Prisma.InvoiceUpdateInput = {};

    if (updateInvoiceDto.dueDate !== undefined) {
      data.dueDate = updateInvoiceDto.dueDate
        ? new Date(updateInvoiceDto.dueDate)
        : null;
    }

    if (updateInvoiceDto.notes !== undefined) {
      data.notes = updateInvoiceDto.notes;
    }

    return this.prisma.$transaction(
      async (tx) => {
        // ------------------------------------------------------
        // Update invoice basic information
        // ------------------------------------------------------

        if (Object.keys(data).length > 0) {
          await tx.invoice.update({
            where: {
              id,
            },
            data,
          });
        }

        // ------------------------------------------------------
        // Return complete invoice
        // ------------------------------------------------------

        return tx.invoice.findUnique({
          where: {
            id,
          },

          include: {
            client: true,
            project: true,
            order: true,
            lines: true,
            creditNotes: true,
            attachments: true,
          },
        });
      },
    );
  }

  // ============================================================
  // REMOVE
  // ============================================================

  async remove(id: string) {
    const invoice =
      await this.prisma.invoice.findUnique({
        where: {
          id,
        },
      });

    if (!invoice) {
      throw new NotFoundException(
        'Invoice not found',
      );
    }

    if (invoice.status !== 'DRAFT') {
      throw new BadRequestException(
        `Invoice with status ${invoice.status} cannot be deleted`,
      );
    }

    return this.prisma.invoice.delete({
      where: {
        id,
      },
    });
  }

  // ============================================================
  // CHANGE STATUS
  // ============================================================

  async changeStatus(
    id: string,
    cancelled = false,
  ) {
    const invoice =
      await this.prisma.invoice.findUnique({
        where: {
          id,
        },
      });

    if (!invoice) {
      throw new NotFoundException(
        'Invoice not found',
      );
    }

    // ----------------------------------------------------------
    // Cancel invoice
    // ----------------------------------------------------------

    if (cancelled) {
      if (
        invoice.status === 'PAID' ||
        invoice.status === 'CANCELLED'
      ) {
        throw new BadRequestException(
          `An invoice with status ${invoice.status} cannot be cancelled`,
        );
      }

      return this.prisma.invoice.update({
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

    // ----------------------------------------------------------
    // Advance status
    // ----------------------------------------------------------

    let nextStatus: any;

  switch (invoice.status) {
  case 'DRAFT':
    nextStatus = 'ISSUED';          // ← corrigé
    break;

  case 'ISSUED':
    nextStatus = 'PARTIALLY_PAID';
    break;

  case 'PARTIALLY_PAID':
    nextStatus = 'PAID';
    break;

  case 'PAID':
    throw new BadRequestException(
      'This invoice has already been fully paid',
    );

  case 'OVERDUE':
    // Selon la logique métier souhaitée :
    // - soit on autorise le paiement après retard,
    // - soit on bloque.
    nextStatus = 'PAID';
    break;

  case 'CANCELLED':
    throw new BadRequestException(
      'This invoice has been cancelled',
    );

  default:
    throw new BadRequestException(
      'Invalid invoice status',
    );
}

    return this.prisma.invoice.update({
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

  // ============================================================
  // GENERATE INVOICE NUMBER
  // ============================================================

  private async generateInvoiceNumber(): Promise<string> {
    const year = new Date().getFullYear();

    const lastInvoice =
      await this.prisma.invoice.findFirst({
        where: {
          number: {
            startsWith: `FAC-${year}-`,
          },
        },

        orderBy: {
          number: 'desc',
        },

        select: {
          number: true,
        },
      });

    let nextNumber = 1;

    if (lastInvoice) {
      const lastNumber = Number(
        lastInvoice.number.split('-').pop(),
      );

      if (!Number.isNaN(lastNumber)) {
        nextNumber = lastNumber + 1;
      }
    }

    return `FAC-${year}-${String(nextNumber).padStart(4, '0')}`;
  }
  // ============================================================
// GENERATE INVOICE PDF
// ============================================================

async generatePdf(id: string): Promise<Buffer> {
  const invoice = await this.prisma.invoice.findUnique({
    where: { id },
    include: {
      client: true,
      project: true,
      order: true,
      lines: true,
    },
  });

  if (!invoice) {
    throw new NotFoundException('Facture introuvable.');
  }

  if (!invoice.lines.length) {
    throw new BadRequestException(
      'Impossible de générer une facture sans lignes.',
    );
  }

  const template = await this.prisma.documentTemplate.findFirst({
    where: {
      type: 'INVOICE',
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
      'Aucun modèle de facture actif défini par défaut.',
    );
  }

  const version = template.versions[0];

  if (!version) {
    throw new ConflictException(
      'Le modèle de facture ne possède aucune version.',
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
      'Le fichier du modèle de facture est introuvable.',
    );
  }

  const formatAmount = (
    value: Prisma.Decimal | number | string | null,
  ): string =>
    Number(value ?? 0).toLocaleString('fr-TN', {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    });

  const remaining = invoice.total.sub(invoice.paidAmount);

  const templateData = {
    invoice: {
      id: invoice.id,
      number: invoice.number,
      issueDate: invoice.issueDate.toLocaleDateString('fr-FR'),
      dueDate: invoice.dueDate
        ? invoice.dueDate.toLocaleDateString('fr-FR')
        : '',
      status: invoice.status,
      notes: invoice.notes ?? '',
      subtotal: formatAmount(invoice.subtotal),
      taxAmount: formatAmount(invoice.taxAmount),
      total: formatAmount(invoice.total),
      paidAmount: formatAmount(invoice.paidAmount),
      remaining: formatAmount(remaining),
    },
    client: invoice.client,
    project: invoice.project,
    order: invoice.order,
    lines: invoice.lines.map((line) => ({
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

// ============================================================
// SEND INVOICE PDF BY EMAIL
// ============================================================

async sendEmail(id: string) {
  const invoice = await this.prisma.invoice.findUnique({
    where: { id },
    include: {
      client: true,
      project: true,
      order: true,
      lines: true,
    },
  });

  if (!invoice) {
    throw new NotFoundException('Facture introuvable.');
  }

  const recipient = invoice.client?.email;

  if (!recipient) {
    throw new BadRequestException(
      "Le client n'a pas d'adresse e-mail.",
    );
  }

  if (!invoice.lines.length) {
    throw new BadRequestException(
      'Impossible d’envoyer une facture sans lignes.',
    );
  }

  const isProduction = process.env.NODE_ENV === 'production';

  const host = isProduction
    ? 'smtp-relay.brevo.com'
    : 'smtp.gmail.com';

  const user = isProduction
    ? process.env.BREVO_LOGIN
    : process.env.SMTP_USER;

  const pass = isProduction
    ? process.env.BREVO_SMTP_KEY
    : process.env.SMTP_PASS;

  if (!user || !pass) {
    throw new BadRequestException(
      'La configuration e-mail est incomplète.',
    );
  }

  const transporter = nodemailer.createTransport({
    host,
    port: 587,
    secure: false,
    auth: { user, pass },
  });

  const pdf = await this.generatePdf(id);

  const safeNumber = invoice.number.replace(
    /[^a-zA-Z0-9_-]/g,
    '_',
  );

  await transporter.sendMail({
    from: user,
    to: recipient,
    subject: `Facture ${invoice.number}`,
    text: [
      `Bonjour ${invoice.client.companyName || ''},`,
      '',
      `Veuillez trouver en pièce jointe la facture ${invoice.number}.`,
      '',
      'Cordialement,',
      'L.I.M.',
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; color: #334155; line-height: 1.6;">
        <p>Bonjour ${escapeHtml(
          invoice.client.companyName || '',
        )},</p>
        <p>
          Veuillez trouver en pièce jointe la facture
          <strong>${escapeHtml(invoice.number)}</strong>.
        </p>
        <p>Cordialement,<br><strong>L.I.M.</strong></p>
      </div>
    `,
    attachments: [
      {
        filename: `facture-${safeNumber}.pdf`,
        content: pdf,
        contentType: 'application/pdf',
      },
    ],
  });

  return {
    success: true,
    message: 'Invoice sent successfully',
    invoiceNumber: invoice.number,
    recipient,
  };
}
// ============================================================
// REGISTER PAYMENT
// ============================================================

async registerPayment(
  id: string,
  amount: number,
) {
  const invoice = await this.prisma.invoice.findUnique({
    where: { id },
  });

  if (!invoice) {
    throw new NotFoundException('Invoice not found');
  }

  if (invoice.status === 'CANCELLED') {
    throw new BadRequestException(
      'Cannot register a payment on a cancelled invoice',
    );
  }

  if (invoice.status === 'PAID') {
    throw new BadRequestException(
      'This invoice has already been fully paid',
    );
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BadRequestException(
      'The payment amount must be a positive number',
    );
  }

  const paymentAmount = new Prisma.Decimal(amount);

  const remaining = invoice.total.sub(invoice.paidAmount);

  if (paymentAmount.greaterThan(remaining)) {
    throw new BadRequestException(
      `Payment amount exceeds remaining balance (${remaining.toString()} TND)`,
    );
  }

  const newPaidAmount = invoice.paidAmount.add(paymentAmount);

  // ----------------------------------------------------------
  // Determine next status
  // ----------------------------------------------------------
  let nextStatus: 'PARTIALLY_PAID' | 'PAID';

  if (newPaidAmount.equals(invoice.total)) {
    nextStatus = 'PAID';
  } else {
    nextStatus = 'PARTIALLY_PAID';
  }

  return this.prisma.invoice.update({
    where: { id },
    data: {
      paidAmount: newPaidAmount,
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
// ============================================================
// GENERATE RECEIPT PDF
// Le template du reçu est fixe (non géré via DocumentTemplate).
// Le style est repris du template de facture actif par défaut.
// ============================================================

async generateReceiptPdf(id: string): Promise<Buffer> {
  const invoice = await this.prisma.invoice.findUnique({
    where: { id },
    include: {
      client: true,
      project: true,
      order: true,
      lines: true,
    },
  });

  if (!invoice) {
    throw new NotFoundException('Facture introuvable.');
  }

  if (invoice.status !== 'PAID') {
    throw new BadRequestException(
      'Un reçu ne peut être généré que pour une facture entièrement payée.',
    );
  }

  if (!invoice.lines.length) {
    throw new BadRequestException(
      'Impossible de générer un reçu sans lignes.',
    );
  }

  // ----------------------------------------------------------
  // 1. Template fixe du reçu
  // ----------------------------------------------------------
  const templatePath = path.resolve(
    process.cwd(),
    'src',
    'templates',
    'receipts',
    'receipt.hbs',
  );
console.log('Template path:', templatePath);
  let templateSource: string;

  try {
    templateSource = await fs.readFile(templatePath, 'utf8');
  } catch {
    throw new ConflictException(
      'Le fichier du modèle de reçu est introuvable.',
    );
  }

  // ----------------------------------------------------------
  // 2. Récupérer le style du template de facture actif
  //    (pour garder une cohérence visuelle avec la facture)
  // ----------------------------------------------------------
  const invoiceTemplate =
    await this.prisma.documentTemplate.findFirst({
      where: {
        type: 'INVOICE',
        isDefault: true,
        isActive: true,
      },
      include: {
        style: true,
      },
    });

  const defaultStyle = {
    primaryColor: '#1e3a8a',
    secondaryColor: '#64748b',
    accentColor: '#0ea5e9',
    textColor: '#1f2937',
    backgroundColor: '#ffffff',
    fontFamily: 'Arial',
    fontSize: 12,
    borderRadius: 8,
    spacing: 16,
    showLogo: true,
    showFooter: true,
    showSignature: true,
  };

  const style = {
    ...defaultStyle,
    ...(invoiceTemplate?.style ?? {}),
  };

  // ----------------------------------------------------------
  // 3. Formatage des montants
  // ----------------------------------------------------------
  const formatAmount = (
    value: Prisma.Decimal | number | string | null,
  ): string =>
    Number(value ?? 0).toLocaleString('fr-TN', {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    });

  const receiptNumber = invoice.number.replace(/^FAC-/, 'REC-');

  // ----------------------------------------------------------
  // 4. Données injectées dans le template
  // ----------------------------------------------------------
  const templateData = {
    receipt: {
      number: receiptNumber,
      issueDate: new Date().toLocaleDateString('fr-FR'),
      paidAmount: formatAmount(invoice.paidAmount),
      paymentMethod: 'Virement bancaire / Chèque',
    },
    invoice: {
      id: invoice.id,
      number: invoice.number,
      issueDate: invoice.issueDate.toLocaleDateString('fr-FR'),
      dueDate: invoice.dueDate
        ? invoice.dueDate.toLocaleDateString('fr-FR')
        : '',
      status: invoice.status,
      notes: invoice.notes ?? '',
      subtotal: formatAmount(invoice.subtotal),
      taxAmount: formatAmount(invoice.taxAmount),
      total: formatAmount(invoice.total),
      paidAmount: formatAmount(invoice.paidAmount),
      remaining: '0,000',
    },
    client: invoice.client,
    project: invoice.project,
    order: invoice.order,
    lines: invoice.lines.map((line) => ({
      description: line.description,
      quantity: formatAmount(line.quantity),
      unitPrice: formatAmount(line.unitPrice),
      taxRate: formatAmount(line.taxRate),
      total: formatAmount(line.total),
    })),
    style,
    generatedAt: new Date().toLocaleDateString('fr-FR'),
  };

  const html = Handlebars.compile(templateSource)(templateData);

  // ----------------------------------------------------------
  // 5. Rendu PDF
  // ----------------------------------------------------------
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
// ============================================================
// SEND RECEIPT PDF BY EMAIL
// ============================================================

async sendReceiptEmail(id: string) {
  // 1. Récupérer la facture et les informations du client
  const invoice = await this.prisma.invoice.findUnique({
    where: { id },
    include: {
      client: true,
      project: true,
      order: true,
      lines: true,
    },
  });

  if (!invoice) {
    throw new NotFoundException('Facture introuvable.');
  }

  // Le reçu n'est disponible que pour une facture entièrement payée.
  if (invoice.status !== 'PAID') {
    throw new BadRequestException(
      'Un reçu ne peut être envoyé que pour une facture entièrement payée.',
    );
  }

  if (!invoice.lines.length) {
    throw new BadRequestException(
      'Impossible d’envoyer un reçu pour une facture sans lignes.',
    );
  }

  const recipientEmail = invoice.client?.email?.trim();

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

  // 3. Générer le PDF du reçu
  const pdf = await this.generateReceiptPdf(id);

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
    invoice.client.companyName ?? 'Client',
  );

  const receiptNumber = escapeHtml(
    invoice.number.replace(/^FAC-/, 'REC-'),
  );

  const invoiceNumber = escapeHtml(invoice.number);

  const receiptDate = escapeHtml(
    new Date().toLocaleDateString('fr-FR'),
  );

  const paidAmount = `${Number(invoice.paidAmount).toLocaleString(
    'fr-TN',
    {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    },
  )} TND`;

  const html = `
    <!DOCTYPE html>
    <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Votre reçu de paiement L.I.M.</title>
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
                Votre reçu de paiement
              </h2>

              <p>Bonjour ${clientName},</p>

              <p>
                Nous vous remercions pour votre règlement.
                Veuillez trouver votre reçu de paiement en pièce jointe.
              </p>

              <div style="background:#f4f6f8;border-radius:8px;
                padding:18px;margin:24px 0;">

                <p style="margin:0 0 12px;">
                  <strong>Numéro de reçu :</strong> ${receiptNumber}
                </p>

                <p style="margin:0 0 12px;">
                  <strong>Facture :</strong> ${invoiceNumber}
                </p>

                <p style="margin:0 0 12px;">
                  <strong>Date :</strong> ${receiptDate}
                </p>

                <p style="margin:0;">
                  <strong>Montant payé :</strong>
                  ${escapeHtml(paidAmount)}
                </p>
              </div>

              <p>
                <strong>Pièce jointe :</strong>
                recu-${receiptNumber}.pdf
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

  const safeNumber = invoice.number
    .replace(/^FAC-/, 'REC-')
    .replace(/[^a-zA-Z0-9_-]/g, '_');

  // 6. Envoyer l'e-mail avec le PDF du reçu en pièce jointe
  try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to: recipientEmail,
      subject: `Votre reçu de paiement ${receiptNumber} — L.I.M.`,
      text:
        `Bonjour ${invoice.client.companyName ?? 'Client'},\n\n` +
        `Nous vous remercions pour votre règlement.\n` +
        `Veuillez trouver ci-joint le reçu de paiement ${receiptNumber} ` +
        `relatif à la facture ${invoice.number}.\n` +
        `Montant payé : ${paidAmount}.\n\n` +
        `Cordialement,\nL'équipe L.I.M.`,
      html,
      attachments: [
        {
          filename: `recu-${safeNumber}.pdf`,
          content: pdf,
          contentType: 'application/pdf',
          contentDisposition: 'attachment',
        },
      ],
    });
  } catch (error) {
    console.error('SMTP receipt sending failed:', error);

    throw new InternalServerErrorException(
      "L'envoi du reçu par e-mail a échoué. Vérifiez la configuration SMTP.",
    );
  }

  return {
    success: true,
    message: 'Le reçu a été envoyé par e-mail.',
    receiptNumber: invoice.number.replace(/^FAC-/, 'REC-'),
    invoiceNumber: invoice.number,
    recipient: recipientEmail,
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