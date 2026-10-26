import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma, QuoteStatus } from 'src/generated/prisma/client';

import { CreateQuoteDto } from './dto/create-quote.dto';
import { UpdateQuoteDto } from './dto/update-quote.dto';

import Handlebars from 'handlebars';
import chromium from '@sparticuz/chromium';
import nodemailer from 'nodemailer';
import { get } from '@vercel/blob';

@Injectable()
export class QuotesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createQuoteDto: CreateQuoteDto) {
    const {
      clientId,
      projectId,
      validUntil,
      notes,
      lines,
    } = createQuoteDto;

    // --------------------------------------------------
    // 1. Validate lines
    // --------------------------------------------------
    if (!lines || lines.length === 0) {
      throw new BadRequestException('A quote must contain at least one line');
    }

    // --------------------------------------------------
    // 2. Check client
    // --------------------------------------------------
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
    });

    if (!client) {
      throw new NotFoundException('Client not found');
    }

    // --------------------------------------------------
    // 3. Check project if provided
    // --------------------------------------------------
    if (projectId) {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
      });

      if (!project) {
        throw new NotFoundException('Project not found');
      }

      if (project.clientId !== clientId) {
        throw new BadRequestException(
          'The selected project does not belong to this client',
        );
      }
    }

    // --------------------------------------------------
    // 4. Calculate quote amounts
    // --------------------------------------------------
    let subtotal = new Prisma.Decimal(0);
    let taxAmount = new Prisma.Decimal(0);

    const calculatedLines = lines.map((line) => {
      const quantity = new Prisma.Decimal(line.quantity);
      const unitPrice = new Prisma.Decimal(line.unitPrice);
      const taxRate = new Prisma.Decimal(line.taxRate);

      const lineSubtotal = quantity.mul(unitPrice);
      const lineTax = lineSubtotal.mul(taxRate).div(100);
      const lineTotal = lineSubtotal.add(lineTax);

      subtotal = subtotal.add(lineSubtotal);
      taxAmount = taxAmount.add(lineTax);

      return {
        description: line.description,
        quantity,
        unitPrice,
        taxRate,
        total: lineTotal,
      };
    });

    const total = subtotal.add(taxAmount);

    // --------------------------------------------------
    // 5. Generate quote number
    // --------------------------------------------------
    const quoteNumber = await this.generateQuoteNumber();

    // --------------------------------------------------
    // 6. Create quote + lines in one transaction
    // --------------------------------------------------
    return this.prisma.$transaction(async (tx) => {
      const quote = await tx.quote.create({
        data: {
          number: quoteNumber,
          validUntil: validUntil ? new Date(validUntil) : undefined,
          status: 'DRAFT',
          subtotal,
          taxAmount,
          total,
          notes,
          clientId,
          projectId,
          lines: { create: calculatedLines },
        },
        include: {
          client: true,
          project: true,
          lines: true,
        },
      });

      return quote;
    });
  }

  private async generateQuoteNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `DEV-${year}-`;

    const lastQuote = await this.prisma.quote.findFirst({
      where: { number: { startsWith: prefix } },
      orderBy: { number: 'desc' },
    });

    let nextNumber = 1;
    if (lastQuote) {
      const lastNumber = parseInt(lastQuote.number.replace(prefix, ''), 10);
      if (!Number.isNaN(lastNumber)) {
        nextNumber = lastNumber + 1;
      }
    }

    return `${prefix}${String(nextNumber).padStart(4, '0')}`;
  }

  async findAll() {
    return await this.prisma.quote.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        client: true,
        project: true,
        lines: true,
      },
    });
  }

  async findOne(id: string) {
    const quote = await this.prisma.quote.findUnique({
      where: { id },
      include: {
        client: true,
        project: true,
        lines: true,
      },
    });

    if (!quote) {
      throw new NotFoundException('Quote not found');
    }

    return quote;
  }

  async update(id: string, updateQuoteDto: UpdateQuoteDto) {
    const { clientId, projectId, validUntil, lines, ...data } = updateQuoteDto;

    const quote = await this.prisma.quote.findUnique({
      where: { id },
    });

    if (!quote) {
      throw new NotFoundException('Quote not found');
    }

    if (clientId !== undefined) {
      const client = await this.prisma.client.findUnique({
        where: { id: clientId },
      });
      if (!client) throw new NotFoundException('Client not found');
    }

    if (projectId !== undefined && projectId !== null) {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
      });
      if (!project) throw new NotFoundException('Project not found');

      const finalClientId = clientId !== undefined ? clientId : quote.clientId;
      if (project.clientId !== finalClientId) {
        throw new BadRequestException(
          'The selected project does not belong to the selected client',
        );
      }
    }

    const updateData: any = { ...data };

    if (clientId !== undefined) {
      updateData.client = { connect: { id: clientId } };
    }

    if (projectId !== undefined) {
      if (projectId === null) {
        updateData.project = { disconnect: true };
      } else {
        updateData.project = { connect: { id: projectId } };
      }
    }

    if (validUntil !== undefined) {
      updateData.validUntil = validUntil ? new Date(validUntil) : null;
    }

    let subtotal = quote.subtotal;
    let taxAmount = quote.taxAmount;
    let total = quote.total;

    const calculatedLines: {
      description: string;
      quantity: Prisma.Decimal;
      unitPrice: Prisma.Decimal;
      taxRate: Prisma.Decimal;
      total: Prisma.Decimal;
    }[] = [];

    if (lines !== undefined) {
      if (lines.length === 0) {
        throw new BadRequestException('A quote must contain at least one line');
      }

      subtotal = new Prisma.Decimal(0);
      taxAmount = new Prisma.Decimal(0);

      for (const line of lines) {
        const quantity = new Prisma.Decimal(line.quantity);
        const unitPrice = new Prisma.Decimal(line.unitPrice);
        const taxRate = new Prisma.Decimal(line.taxRate);

        const lineSubtotal = quantity.mul(unitPrice);
        const lineTax = lineSubtotal.mul(taxRate).div(100);
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

      total = subtotal.add(taxAmount);

      updateData.subtotal = subtotal;
      updateData.taxAmount = taxAmount;
      updateData.total = total;
    }

    return this.prisma.$transaction(async (tx) => {
      if (lines !== undefined) {
        await tx.quoteLine.deleteMany({ where: { quoteId: id } });
        await tx.quoteLine.createMany({
          data: calculatedLines.map((line) => ({
            quoteId: id,
            description: line.description,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            taxRate: line.taxRate,
            total: line.total,
          })),
        });
      }

      return tx.quote.update({
        where: { id },
        data: updateData,
        include: {
          client: true,
          project: true,
          lines: true,
        },
      });
    });
  }

  async remove(id: string) {
    const quote = await this.prisma.quote.findUnique({
      where: { id },
    });

    if (!quote) {
      throw new NotFoundException('Quote not found');
    }

    return await this.prisma.quote.delete({
      where: { id },
    });
  }

  async changeStatus(id: string, cancelled = false) {
    const quote = await this.prisma.quote.findUnique({
      where: { id },
    });

    if (!quote) {
      throw new NotFoundException('Quote not found');
    }

    if (cancelled) {
      if (
        quote.status === 'TRANSFORMED' ||
        quote.status === 'REJECTED' ||
        quote.status === 'EXPIRED' ||
        quote.status === 'CANCELLED'
      ) {
        throw new BadRequestException(
          `A quote with status ${quote.status} cannot be cancelled`,
        );
      }

      return this.prisma.quote.update({
        where: { id },
        data: { status: 'CANCELLED' },
        include: { client: true, project: true, lines: true },
      });
    }

    let nextStatus: QuoteStatus;

    switch (quote.status) {
      case 'DRAFT':
        nextStatus = 'SENT';
        break;
      case 'SENT':
        nextStatus = 'ACCEPTED';
        break;
      case 'ACCEPTED':
        throw new BadRequestException('An accepted quote must be transformed into an order');
      case 'REJECTED':
        throw new BadRequestException('This quote has already been rejected');
      case 'EXPIRED':
        throw new BadRequestException('This quote has expired');
      case 'TRANSFORMED':
        throw new BadRequestException('This quote has already been transformed');
      case 'CANCELLED':
        throw new BadRequestException('This quote has been cancelled');
      default:
        throw new BadRequestException('Invalid quote status');
    }

    return this.prisma.quote.update({
      where: { id },
      data: { status: nextStatus },
      include: { client: true, project: true, lines: true },
    });
  }

  async generatePdf(id: string): Promise<Buffer> {
    // 1. Récupérer le devis
    const quote = await this.prisma.quote.findUnique({
      where: { id },
      include: {
        client: true,
        project: true,
        lines: true,
      },
    });

    if (!quote) {
      throw new NotFoundException('Devis introuvable.');
    }

    // 2. Récupérer le modèle QUOTE actif défini par défaut
    const template = await this.prisma.documentTemplate.findFirst({
      where: {
        type: 'QUOTE',
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
      throw new ConflictException('Aucun modèle de devis actif défini par défaut.');
    }

    const version = template.versions[0];
    if (!version) {
      throw new ConflictException('Le modèle de devis par défaut ne possède aucune version.');
    }

    // 3. Lire le template depuis Vercel Blob
    let templateSource: string;

    if (
      !version.storagePath.startsWith('https://') ||
      !version.storagePath.includes('.blob.vercel-storage.com/')
    ) {
      throw new ConflictException(
        'Le fichier du modèle utilise un ancien chemin local. Veuillez le téléverser à nouveau.',
      );
    }

    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      throw new InternalServerErrorException('BLOB_READ_WRITE_TOKEN is not configured');
    }

    try {
      const result = await get(version.storagePath, {
        access: 'private',
        token,
      });

      if (!result || result.statusCode !== 200 || !result.stream) {
        throw new Error('Le fichier Blob est introuvable ou inaccessible.');
      }

      const chunks: Buffer[] = [];
      for await (const chunk of result.stream) {
        chunks.push(Buffer.from(chunk));
      }

      templateSource = Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      console.error('[QUOTE PDF] Erreur de lecture Vercel Blob :', error);
      throw new ConflictException(
        'Impossible de récupérer le fichier du modèle de devis depuis Vercel.',
      );
    }

    // 4. Formater les montants
    const formatAmount = (value: Prisma.Decimal | number | string | null): string => {
      return Number(value ?? 0).toLocaleString('fr-TN', {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      });
    };

    // 5. Préparer les données du template
    const templateData = {
      quote: {
        id: quote.id,
        number: quote.number,
        issueDate: quote.issueDate.toLocaleDateString('fr-FR'),
        validUntil: quote.validUntil?.toLocaleDateString('fr-FR') ?? '',
        status: quote.status,
        notes: quote.notes ?? '',
        subtotal: formatAmount(quote.subtotal),
        taxAmount: formatAmount(quote.taxAmount),
        total: formatAmount(quote.total),
      },
      client: quote.client,
      project: quote.project,
      lines: quote.lines.map((line) => ({
        description: line.description,
        quantity: formatAmount(line.quantity),
        unitPrice: formatAmount(line.unitPrice),
        taxRate: formatAmount(line.taxRate),
        total: formatAmount(line.total),
      })),
      style: template.style ?? {
        primaryColor: '#1F2937',
        secondaryColor: '#6B7280',
        accentColor: '#2563EB',
        textColor: '#111827',
        backgroundColor: '#FFFFFF',
        fontFamily: 'Arial',
        fontSize: 10,
        borderRadius: 0,
        spacing: 8,
        showLogo: true,
        showFooter: true,
        showSignature: true,
      },
      generatedAt: new Date().toLocaleDateString('fr-FR'),
    };

    // 6. Compiler le template HTML/HBS
    const compiledTemplate = Handlebars.compile(templateSource);
    const html = compiledTemplate(templateData);

    // =========================================================
    // 7. Générer le PDF avec Puppeteer (Importation dynamique)
    // =========================================================
    // 👇 On utilise await import() pour charger le module ESM
    const puppeteer = (await import('puppeteer-core')).default;
    
    // Si chromium est aussi un module ESM, on fait pareil :
    const chromiumModule = (await import('@sparticuz/chromium')).default;

    const browser = await puppeteer.launch({
      args: chromiumModule.args,
      defaultViewport: { width: 1200, height: 800 }, // 👈 Valeur manuelle
      executablePath: await chromiumModule.executablePath(),
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
    const quote = await this.findOne(id);

    const recipientEmail = quote.client.email?.trim();
    if (!recipientEmail) {
      throw new BadRequestException("Le client ne possède pas d'adresse e-mail.");
    }

    const {
      SMTP_HOST,
      SMTP_PORT,
      SMTP_SECURE,
      SMTP_USER,
      SMTP_PASS,
      SMTP_FROM,
    } = process.env;

    if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
      throw new InternalServerErrorException('La configuration SMTP est incomplète.');
    }

    const pdf = await this.generatePdf(id);

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

    const clientName = escapeHtml(quote.client.companyName ?? 'Client');
    const quoteNumber = escapeHtml(quote.number);
    const quoteDate = escapeHtml(quote.issueDate.toLocaleDateString('fr-FR'));
    const quoteTotal = `${Number(quote.total).toLocaleString('fr-TN', {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    })} TND`;

    const html = `
      <!DOCTYPE html>
      <html lang="fr">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Votre devis L.I.M.</title>
        </head>
        <body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
          <div style="padding:32px 12px;">
            <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;">
              <div style="background:#1f2937;padding:24px;text-align:center;">
                <h1 style="margin:0;color:#ffffff;font-size:23px;">L.I.M. — Louay Industry &amp; Maintenance</h1>
              </div>
              <div style="padding:30px 26px;">
                <h2 style="margin-top:0;font-size:21px;">Votre devis est prêt</h2>
                <p>Bonjour ${clientName},</p>
                <p>Nous vous remercions pour votre confiance. Veuillez trouver votre devis en pièce jointe.</p>
                <div style="background:#f4f6f8;border-radius:8px;padding:18px;margin:24px 0;">
                  <p style="margin:0 0 12px;"><strong>Numéro du devis :</strong> ${quoteNumber}</p>
                  <p style="margin:0 0 12px;"><strong>Date :</strong> ${quoteDate}</p>
                  <p style="margin:0;"><strong>Montant total :</strong> ${escapeHtml(quoteTotal)}</p>
                </div>
                <p><strong>Pièce jointe :</strong> devis-${quoteNumber}.pdf</p>
                <p>Pour toute question ou information complémentaire, n'hésitez pas à nous contacter.</p>
                <p style="margin-bottom:0;">Cordialement,<br><strong>L'équipe L.I.M.</strong></p>
              </div>
              <div style="background:#f4f6f8;padding:18px 24px;text-align:center;color:#6b7280;font-size:12px;">
                L.I.M. — Louay Industry &amp; Maintenance
              </div>
            </div>
          </div>
        </body>
      </html>
    `;

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: SMTP_SECURE === 'true',
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });

    try {
      await transporter.sendMail({
        from: SMTP_FROM,
        to: recipientEmail,
        subject: `Votre devis ${quote.number} — L.I.M.`,
        text: `Bonjour ${quote.client.companyName ?? 'Client'},\n\nVeuillez trouver ci-joint le devis ${quote.number}.\nMontant total : ${quoteTotal}.\n\nCordialement,\nL'équipe L.I.M.`,
        html,
        attachments: [
          {
            filename: `devis-${quote.number}.pdf`,
            content: pdf,
            contentType: 'application/pdf',
            contentDisposition: 'attachment',
          },
        ],
      });
    } catch (error) {
      console.error('SMTP quote sending failed:', error);
      throw new InternalServerErrorException(
        "L'envoi du devis par e-mail a échoué. Vérifiez la configuration SMTP.",
      );
    }

    if (quote.status === 'DRAFT') {
      await this.prisma.quote.update({
        where: { id },
        data: { status: 'SENT' },
      });
    }

    return {
      success: true,
      message: 'Le devis a été envoyé par e-mail.',
      quoteNumber: quote.number,
      recipient: recipientEmail,
    };
  }
}