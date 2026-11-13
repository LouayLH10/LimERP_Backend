import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { get, del } from '@vercel/blob';
import Handlebars from 'handlebars';

import { PrismaService } from '../prisma/prisma.service';
import { EmployeePosition } from '../generated/prisma/enums';
import { QuotesService } from 'src/quote/quote.service';

type AIWorkPhaseInput = {
  name: string;
  description?: string | null;
  order: number;
  durationDays: number;
  estimatedCost?: number | null;
};

type AIWorkforceInput = {
  position: string;
  quantity: number;
  reason?: string | null;
};

type AIQuoteLine = {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
};

type AIQuote = {
  validUntil: string;
  notes: string;
  lines: AIQuoteLine[];
};

type AIResult = {
  resumeProjet: string;
  estimatedPrice: number;
  minPrice?: number | null;
  maxPrice?: number | null;
  durationDays: number;
  minDurationDays?: number | null;
  maxDurationDays?: number | null;
  confidence?: number | null;
  currency?: string;
  workPhases: AIWorkPhaseInput[];
  workforce: AIWorkforceInput[];
  hypotheses: string[];
  missingInformation: string[];
  quote?: AIQuote | null;
};

@Injectable()
export class ProjectAiService {
  private readonly openRouterBaseUrl = 'https://openrouter.ai/api/v1';
  private readonly openRouterModel = 'openrouter/free';

  // =========================================================
  // PARAMÈTRES DE COÛTS BASÉS SUR LE MARCHÉ TUNISIEN
  // Sources : SalaryExpert (2026) pour les salaires bruts
  // Technicien maintenance préventive : ~10,89 TND/h [citation:8]
  // Mécanicien maintenance machines : ~10,21 TND/h [citation:2]
  // Ouvrier fabrication : ~5,56 TND/h [citation:9]
  // On applique un coefficient de 1,8 pour charges patronales + frais généraux
  // =========================================================
  
  /** Coût journalier entreprise pour un technicien (8h, charges incluses) */
  private readonly COUT_JOUR_TECHNICIEN = 180; // TND HT/jour
  
  /** Coût journalier entreprise pour un chef d'équipe (8h, charges incluses) */
  private readonly COUT_JOUR_CHEF_EQUIPE = 260; // TND HT/jour
  
  /** Taux de TVA standard en Tunisie */
  private readonly TVA_RATE = 0.19;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly quotesService: QuotesService,
  ) {}

  private getOpenRouterApiKey(): string {
    const apiKey = this.config.get<string>('OPENROUTER_API_KEY');
    if (!apiKey?.trim()) {
      throw new InternalServerErrorException(
        "La clé API OpenRouter n'est pas configurée. Ajoute OPENROUTER_API_KEY dans le fichier .env.",
      );
    }
    return apiKey.trim();
  }

  private getBlobToken(): string {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      throw new InternalServerErrorException(
        "Le token BLOB_READ_WRITE_TOKEN n'est pas configuré dans le fichier .env.",
      );
    }
    return token;
  }

  async processSpecificationFromVercel(
    projectId: string,
    blobUrl: string,
    originalName: string,
    mimeType: string,
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException('Projet introuvable.');
    }

    let extractedText = '';
    let fileBuffer: Buffer;

    try {
      const result = await get(blobUrl, {
        access: 'private',
        token: this.getBlobToken(),
      });

      if (!result || result.statusCode !== 200 || !result.stream) {
        throw new Error('Fichier introuvable sur Vercel.');
      }

      const chunks: Buffer[] = [];
      for await (const chunk of result.stream) {
        chunks.push(Buffer.from(chunk));
      }
      fileBuffer = Buffer.concat(chunks);
    } catch (error: any) {
      console.error('[Project AI] Erreur de téléchargement:', error);
      throw new BadRequestException(
        'Impossible de lire le document depuis Vercel Blob.',
      );
    }

    const extension = extname(originalName).toLowerCase();
    try {
      if (extension === '.pdf') {
        const pdf = await pdfParse(fileBuffer);
        extractedText = pdf.text?.trim() ?? '';
      } else {
        const resultDocx = await mammoth.extractRawText({ buffer: fileBuffer });
        extractedText = resultDocx.value.trim();
      }
    } catch (error) {
      console.error('[Project AI] Erreur d\'extraction du texte:', error);
      throw new BadRequestException('Erreur lors de la lecture du document.');
    }

    if (!extractedText) {
      throw new BadRequestException(
        'Aucun texte extractible. Un OCR peut être nécessaire.',
      );
    }

    try {
      const previous = await this.prisma.projectSpecification.findUnique({
        where: { projectId },
        select: { id: true, storagePath: true },
      });

      const specification = await this.prisma.$transaction(async (tx) => {
        await tx.projectAIAnalysis.deleteMany({ where: { projectId } });

        const generatedFileName =
          blobUrl.split('/').pop() || `${randomUUID()}${extension}`;

        return tx.projectSpecification.upsert({
          where: { projectId },
          create: {
            projectId,
            fileName: generatedFileName,
            originalName: originalName,
            mimeType,
            fileSize: fileBuffer.length,
            storagePath: blobUrl,
            extractedText,
          },
          update: {
            fileName: generatedFileName,
            originalName: originalName,
            mimeType,
            fileSize: fileBuffer.length,
            storagePath: blobUrl,
            extractedText,
          },
        });
      });

      if (previous?.storagePath && previous.storagePath !== blobUrl) {
        if (previous.storagePath.includes('.blob.vercel-storage.com/')) {
          await del(previous.storagePath, { token: this.getBlobToken() }).catch(
            (err) => console.warn('[Project AI] Impossible de supprimer l\'ancien blob:', err.message),
          );
        }
      }

      return {
        message: 'Cahier des charges importé et texte extrait.',
        specification,
        extractedCharacters: extractedText.length,
      };
    } catch (error) {
      throw error;
    }
  }

  async getPrivateFile(fileUrl: string): Promise<Buffer> {
    if (
      !fileUrl.startsWith('https://') ||
      !fileUrl.includes('.blob.vercel-storage.com/')
    ) {
      throw new BadRequestException('URL Blob invalide');
    }

    const result = await get(fileUrl, {
      access: 'private',
      token: this.getBlobToken(),
    });

    if (!result || result.statusCode !== 200 || !result.stream) {
      throw new NotFoundException('Fichier introuvable');
    }

    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  async getSpecification(projectId: string) {
    return this.prisma.projectSpecification.findUnique({
      where: { projectId },
    });
  }

  async analyzeProject(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { client: true, specification: true },
    });

    if (!project) {
      throw new NotFoundException('Projet introuvable.');
    }

    const specification = project.specification;
    if (!specification?.extractedText?.trim()) {
      throw new BadRequestException(
        'Importe d’abord un cahier des charges contenant du texte.',
      );
    }

    const analysis = await this.prisma.projectAIAnalysis.create({
      data: {
        projectId,
        specificationId: specification.id,
        status: 'PROCESSING',
      },
    });

    try {
      console.log(`[Project AI] Début de l'analyse : ${projectId}`);

      const analysisResult = await this.callOpenRouterForAnalysis({
        projectName: project.name,
        projectDescription: project.description ?? '',
        location: project.location ?? '',
        clientName: (project.client as { name?: string }).name ?? '',
        extractedText: specification.extractedText,
      });

      console.log('[Project AI] Validation des données (analyse)...');
      this.validateAnalysisResult(analysisResult);
      console.log('[Project AI] Validation analyse terminée.');

      const validPositions = new Set<string>(Object.values(EmployeePosition));

      const workforce = analysisResult.workforce
        .filter(
          (item) =>
            validPositions.has(item.position) &&
            Number.isFinite(item.quantity),
        )
        .map((item) => ({
          position: item.position as EmployeePosition,
          quantity: Math.floor(item.quantity),
          reason: item.reason ?? null,
        }))
        .filter((item) => item.quantity > 0);

      // =========================================================
      // CALCUL DES COÛTS RÉELS DES PHASES
      // On utilise le coût journalier tunisien, pas le prix IA brut
      // =========================================================
      let totalHT = 0;
      const workPhases = analysisResult.workPhases.map((phase, index) => {
        // Coût de base = jours × coût journalier technicien
        // Si l'IA a fourni un estimatedCost, on le compare et on prend
        // la valeur la plus réaliste (on ne fait pas confiance à un coût
        // inférieur au plancher technique)
        const baseCost = phase.durationDays * this.COUT_JOUR_TECHNICIEN;
        let estimatedCost = phase.estimatedCost ?? baseCost;
        
        // Plancher : le coût ne peut pas être inférieur au coût main-d'œuvre pur
        const floorCost = phase.durationDays * this.COUT_JOUR_TECHNICIEN * 0.6;
        if (estimatedCost < floorCost) {
          estimatedCost = floorCost;
        }

        totalHT += estimatedCost;

        return {
          name: phase.name,
          description: phase.description ?? null,
          order: phase.order ?? index + 1,
          durationDays: phase.durationDays,
          estimatedCost: Math.round(estimatedCost * 100) / 100,
        };
      });

      const totalTVA = totalHT * this.TVA_RATE;
      const totalTTC = totalHT + totalTVA;

      const saved = await this.prisma.projectAIAnalysis.update({
        where: { id: analysis.id },
        data: {
          status: 'COMPLETED',
          summary: analysisResult.resumeProjet,
          assumptions: JSON.stringify(analysisResult.hypotheses ?? []),
          missingInformation: JSON.stringify(
            analysisResult.missingInformation ?? [],
          ),
          rawResponse: JSON.stringify(analysisResult),
          estimation: {
            create: {
              estimatedPrice: analysisResult.estimatedPrice,
              minPrice: analysisResult.minPrice ?? null,
              maxPrice: analysisResult.maxPrice ?? null,
              durationDays: analysisResult.durationDays,
              minDurationDays: analysisResult.minDurationDays ?? null,
              maxDurationDays: analysisResult.maxDurationDays ?? null,
              confidence: analysisResult.confidence ?? null,
              currency: analysisResult.currency || 'TND',
            },
          },
          workPhases: { create: workPhases },
          workforce: { create: workforce },
          priceSchedule: {
            create: {
              totalHT,
              totalTVA,
              totalTTC,
            }
          }
        },
        include: {
          estimation: true,
          workPhases: { orderBy: { order: 'asc' } },
          workforce: true,
          priceSchedule: true,
        },
      });

      let createdQuote: Awaited<
        ReturnType<typeof this.quotesService.create>
      > | null = null;

      try {
        const quote = await this.callOpenRouterForQuote(analysisResult);

        if (quote && quote.lines?.length > 0) {
          let validUntil = new Date(quote.validUntil);
          if (Number.isNaN(validUntil.getTime()) || validUntil <= new Date()) {
            validUntil = new Date();
            validUntil.setDate(validUntil.getDate() + 30);
          }

          // Vérifier que les prix du devis sont cohérents avec le marché tunisien
          // (on applique un plancher basé sur la durée × coût journalier)
          const quoteLines = quote.lines.map((line) => {
            const minPrice = analysisResult.durationDays * this.COUT_JOUR_TECHNICIEN * 0.5;
            const adjustedUnitPrice = Math.max(line.unitPrice, minPrice);
            return {
              description: line.description.trim(),
              quantity: line.quantity,
              unitPrice: Math.round(adjustedUnitPrice * 100) / 100,
              taxRate: line.taxRate,
            };
          });

          createdQuote = await this.quotesService.create({
            clientId: project.clientId,
            projectId: project.id,
            validUntil: validUntil.toISOString(),
            notes:
              quote.notes?.trim() ||
              `Devis généré automatiquement par IA pour le projet "${project.name}".`,
            lines: quoteLines,
          });
        }
      } catch (quoteError) {
        console.error(
          '[Project AI] Impossible de créer le devis automatiquement :',
          quoteError,
        );
      }

      return {
        ...saved,
        quote: createdQuote,
        avertissementPrix:
          'Estimation indicative générée par IA. Les tarifs et quantités doivent être validés avant la création du devis. Les coûts sont basés sur les salaires du marché tunisien (technicien maintenance ~180 TND/jour charges incluses).',
        hypotheses: analysisResult.hypotheses ?? [],
        informationsManquantes: analysisResult.missingInformation ?? [],
      };
    } catch (error) {
      console.error(`[Project AI] Échec de l'analyse ${analysis.id}`, error);

      await this.prisma.projectAIAnalysis
        .update({
          where: { id: analysis.id },
          data: { status: 'FAILED' },
        })
        .catch((updateError) => {
          console.error(
            '[Project AI] Impossible de mettre à jour le statut FAILED :',
            updateError,
          );
        });

      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      throw new InternalServerErrorException(
        'Échec de l’analyse IA. Consulte les logs du serveur NestJS pour identifier la cause.',
      );
    }
  }

  async getProjectAnalyses(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundException('Projet introuvable.');
    }

    return this.prisma.projectAIAnalysis.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: {
        estimation: true,
        workPhases: { orderBy: { order: 'asc' } },
        workforce: true,
        priceSchedule: true,
      },
    });
  }

  async getAnalysis(projectId: string, analysisId: string) {
    const analysis = await this.prisma.projectAIAnalysis.findFirst({
      where: { id: analysisId, projectId },
      include: {
        estimation: true,
        workPhases: { orderBy: { order: 'asc' } },
        workforce: true,
        priceSchedule: true,
        specification: { select: { id: true, originalName: true } },
      },
    });

    if (!analysis) {
      throw new NotFoundException('Analyse introuvable.');
    }

    return analysis;
  }

  async generatePriceSchedulePdf(analysisId: string, projectId: string): Promise<Buffer> {
    const analysis = await this.prisma.projectAIAnalysis.findUnique({
      where: { id: analysisId },
      include: {
        specification: {
          include: {
            project: {
              include: { client: true }
            }
          }
        },
      }
    });

    if (!analysis) {
      throw new NotFoundException('Analyse introuvable.');
    }

    const project = analysis.specification.project;

    const quote = await this.prisma.quote.findFirst({
      where: { projectId: analysis.projectId },
      include: { lines: true }
    });

    if (!quote) {
      throw new NotFoundException('Devis introuvable pour ce projet.');
    }

    const detailedSchedule = await this.callOpenRouterForDetailedPrice(quote, project);

    let calculatedTotalGeneral = 0;

    const calculatedSections = detailedSchedule.sections.map((sec: any, index: number) => {
      const quoteLine = quote.lines[index];
      if (!quoteLine) return null;

      const lineTotalHT = Number(quoteLine.unitPrice) * Number(quoteLine.quantity);

      let items = sec.items.map((item: any) => {
        const percent = Number(item.percentage) || 33.33;
        return {
          description: item.description,
          amount: lineTotalHT * (percent / 100)
        };
      });

      const currentSum = items.reduce((sum: number, item: any) => sum + item.amount, 0);
      const diff = lineTotalHT - currentSum;

      if (items.length > 0) {
        items[0].amount += diff;
      }

      calculatedTotalGeneral += lineTotalHT;

      return {
        title: `${index + 1}. Justification de : ${quoteLine.description}`,
        items: items,
        subtotal: lineTotalHT
      };
    }).filter(Boolean);

    const template = await this.prisma.documentTemplate.findFirst({
      where: { type: 'QUOTE', isDefault: true, isActive: true },
      include: { style: true },
    });

    const templateSource = `
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700&display=swap" rel="stylesheet">
        <style>
          @page { size: A4; margin: 0; }
          
          body {
            font-family: 'Cairo', '{{style.fontFamily}}', Arial, sans-serif;
            color: {{style.textColor}};
            margin: 0; padding: 0;
            background: {{style.backgroundColor}};
            position: relative;
            -webkit-print-color-adjust: exact;
          }
          
          .watermark {
            position: fixed; top: 50%; left: 50%;
            transform: translate(-50%, -50%) rotate(-30deg);
            font-size: 150px; font-weight: bold;
            color: {{style.primaryColor}}; opacity: 0.04;
            z-index: -1; letter-spacing: 10px; white-space: nowrap;
          }

          .page-container { 
            padding: 40px 50px; 
            min-height: 100vh; 
            display: flex; 
            flex-direction: column; 
          }
          
          .header-main { display: flex; align-items: center; justify-content: space-between; margin-bottom: 30px; }
          .header-logo-left { flex: 0 0 150px; }
          .header-logo-left img { height: 70px; object-fit: contain; }
          .header-center { flex: 1; text-align: center; padding: 0 20px; }
          .header-center h1 { color: {{style.primaryColor}}; margin: 0; font-size: 24px; font-weight: 700; }
          .header-center p { margin: 5px 0 0 0; font-size: 13px; color: {{style.secondaryColor}}; letter-spacing: 1px; }
          .header-logo-right { flex: 0 0 150px; text-align: right; }
          .header-logo-right img { height: 70px; object-fit: contain; }
          .header-line { border-bottom: 2px solid {{style.primaryColor}}; margin-bottom: 20px; }
          
          .doc-bar { background: {{style.primaryColor}}; color: white; display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; border-radius: {{style.borderRadius}}px; margin-bottom: 30px; }
          .doc-bar h2 { margin: 0; font-size: 24px; text-transform: uppercase; letter-spacing: 2px; }
          .doc-bar .doc-number { font-size: 16px; font-weight: bold; }

          .report-section { margin-bottom: 30px; page-break-inside: avoid; }
          .report-title { font-size: 16px; font-weight: bold; color: {{style.primaryColor}}; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px; margin-bottom: 10px; }
          .report-table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
          .report-table td { padding: 8px 0; border-bottom: 1px dotted #e2e8f0; font-size: 13px; }
          .report-table td.amount { text-align: right; font-weight: bold; width: 120px; }
          .subtotal-row td { font-weight: bold; color: {{style.primaryColor}}; border-bottom: none; padding-top: 15px; font-size: 14px; }

          .grand-total-section {
            margin-top: 40px;
            padding: 20px;
            background: #f8fafc;
            border-left: 4px solid {{style.accentColor}};
            page-break-inside: avoid;
          }
          .grand-total-row { display: flex; justify-content: space-between; font-size: 20px; font-weight: bold; color: {{style.primaryColor}}; }

          footer {
            margin-top: auto;
            padding-top: 20px;
            border-top: 1px solid #e2e8f0; 
            font-size: 9px;
            text-align: center; color: #64748b; line-height: 1.5;
          }
          footer .company-name { font-weight: bold; color: {{style.primaryColor}}; font-size: 11px; margin-bottom: 5px; }
        </style>
      </head>
      <body>
        <div class="watermark">LIM</div>
        
        <div class="page-container">
          
          <div class="header-main">
            <div class="header-logo-left"><img src="https://i.ibb.co/vCC87Tky/logo.png" alt="Logo LIM" /></div>
            <div class="header-center">
              <h1><bdi>شركة لؤي للصناعة و الصيانة</bdi></h1>
              <p>SOCIETE LOUAY INDUSTRIE ET MAINTENANCE</p>
            </div>
            <div class="header-logo-right"><img src="https://i.ibb.co/21RN2hdL/ICM-ISO-Certification-Logo.png" alt="ISO" /></div>
          </div>
          <div class="header-line"></div>

          <div class="doc-bar">
            <h2>JUSTIFICATION DU DEVIS</h2>
            <span class="doc-number">Projet : {{project.name}}</span>
          </div>

          <p style="font-size: 14px; margin-bottom: 30px;">
            Le présent document détaille la répartition des coûts du devis <strong>N° {{quoteNumber}}</strong>. Il justifie les prix forfaitaires par des charges réelles de main-d'œuvre, de consommables et de logistique.
          </p>

          {{#each priceSchedule.sections}}
            <div class="report-section">
              <div class="report-title">{{this.title}}</div>
              <table class="report-table">
                {{#each this.items}}
                <tr>
                  <td>{{this.description}}</td>
                  <td class="amount">{{this.amount}} DT</td>
                </tr>
                {{/each}}
                <tr class="subtotal-row">
                  <td>Sous-total</td>
                  <td class="amount">{{this.subtotal}} DT</td>
                </tr>
              </table>
            </div>
          {{/each}}

          <div class="grand-total-section">
            <div class="grand-total-row">
              <span>COÛT TOTAL ESTIMATIF (HT)</span>
              <span>{{priceSchedule.totalGeneral}} DT</span>
            </div>
            <p style="margin-top: 10px; font-size: 12px; color: #64748b;">
              * DT HTVA – Hors pièces de rechange fournies par le client.
            </p>
          </div>

          <footer>
            <div class="company-name"><bdi>شركة لؤي للصناعة و الصيانة</bdi> - SOCIETE LOUAY INDUSTRIE ET MAINTENANCE</div>
            <div>Rue Ali Dargouth, Imm El Moustakbal 5, 1001 Tunis 1er étage BN 10 | Bureaux de Gabès : N° 08 Rue al anbar, 1er étage Gabès Ville 6040</div>
            <div>Tel fixe : 00 216 70038568 | GSM : (00216) 28 815 988 | Mail : lim_commercial@outlook.com / samirhcine@hotmail.com</div>
            <div>WWW.LIM.TN | SARL Capital 210 000 DT | Code TVA 929854/AAM/000</div>
          </footer>

        </div>

      </body>
      </html>
    `;

    const formatMoney = (value: number | string | any | null | undefined): string =>
      Number(value ?? 0).toLocaleString('fr-TN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

    const templateData = {
      project: { name: project.name },
      quoteNumber: quote.number,
      priceSchedule: {
        sections: calculatedSections.map((sec: any) => ({
          title: sec.title,
          items: sec.items.map((item: any) => ({
            description: item.description,
            amount: formatMoney(item.amount)
          })),
          subtotal: formatMoney(sec.subtotal)
        })),
        totalGeneral: formatMoney(calculatedTotalGeneral)
      },
      style: template?.style || {
        primaryColor: '#1F2937',
        secondaryColor: '#6B7280',
        accentColor: '#2563EB',
        textColor: '#111827',
        backgroundColor: '#FFFFFF',
        fontFamily: 'Arial',
        borderRadius: 0,
      },
    };

    const html = Handlebars.compile(templateSource)(templateData);

    const puppeteer = (await import('puppeteer-core')).default;
    const chromium = (await import('@sparticuz/chromium')).default;

    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });

      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
      });

      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  // =========================================================
  // APPELS OPENROUTER
  // =========================================================

  private async callOpenRouterForDetailedPrice(quote: any, project: any): Promise<any> {
    const prompt = `
Tu es un expert en chiffrage industriel pour l'entreprise LIM.

Le devis pour le projet "${project.name}" a été validé.

Ta mission est de générer une structure de justification pour le Bordereau de Prix.
Pour CHAQUE ligne du devis ci-dessous, tu dois proposer 3 sous-tâches (Main d'œuvre, Consommables, Logistique) et leur attribuer un POURCENTAGE (qui doit faire 100% au total pour cette ligne).

Voici les lignes du devis :
${JSON.stringify(quote.lines.map((l: any) => ({ description: l.description, unitPrice: l.unitPrice, quantity: l.quantity })))}

Retourne EXCLUSIVEMENT ce format JSON (ne calcule pas les montants, mets juste les pourcentages) :
{
  "sections": [
    {
      "title": "Justification de : Refroidisseur Polytrack",
      "items": [
        { "description": "Main d'œuvre mécanique et encadrement", "percentage": 70 },
        { "description": "Consommables et petites fournitures", "percentage": 15 },
        { "description": "Logistique, transport et hébergement", "percentage": 15 }
      ]
    }
  ]
}
`;

    return this.callOpenRouterApi({
      prompt,
      maxTokens: 8000,
      systemPrompt: "Tu es un expert en chiffrage. Réponds uniquement en JSON valide et en français."
    });
  }

  private async callOpenRouterForAnalysis(input: {
    projectName: string;
    projectDescription: string;
    location: string;
    clientName: string;
    extractedText: string;
  }): Promise<AIResult> {
    const availablePositions = Object.values(EmployeePosition).join(', ');

    const prompt = `
Tu es un ingénieur expert en maintenance industrielle et préparation
de devis pour une entreprise tunisienne.

Analyse le cahier des charges ci-dessous. Le document peut être en
français, en arabe ou en anglais. Réponds toujours en français.

Retourne exclusivement un objet JSON valide, sans Markdown.

RÈGLES STRICTES POUR L'ESTIMATION DES COÛTS ET DURÉES (MARCHÉ TUNISIEN) :
1. Si le document mentionne une durée d'arrêt (ex: 18 jours) et des horaires (ex: 12h/jour), tu DOIS utiliser ces données.
2. Pour estimer le coût d'une phase, base-toi sur le coût réel de la main-d'œuvre en Tunisie :
   - Un technicien de maintenance gagne environ 10-11 TND brut/heure [citation:2][citation:8].
   - Avec les charges patronales et frais généraux, le coût entreprise est d'environ 180 TND/jour (8h).
   - Pour une équipe de 3 techniciens + 1 chef d'équipe, compte environ 600-800 TND/jour.
   - N'invente pas de prix trop bas. Un grand ensemble industriel nécessite au minimum 5 000 TND de main-d'œuvre.
3. Propose les tâches, les phases, la durée et les effectifs nécessaires.
4. Les postes (workforce) doivent obligatoirement correspondre à l'une des valeurs de cet enum :
  ${availablePositions}
5. Si les données sont insuffisantes, indique-le dans missingInformation.
6. estimatedPrice, durationDays, workPhases et workforce doivent être présents.

Structure obligatoire :
{
  "resumeProjet": "string",
  "estimatedPrice": 0,
  "minPrice": 0,
  "maxPrice": 0,
  "durationDays": 1,
  "minDurationDays": 1,
  "maxDurationDays": 1,
  "confidence": 50,
  "currency": "TND",
  "workPhases": [
    {
      "name": "string",
      "description": "string",
      "order": 1,
      "durationDays": 1,
      "estimatedCost": null
    }
  ],
  "workforce": [
    {
      "position": "TEAM_LEADER",
      "quantity": 1,
      "reason": "string"
    }
  ],
  "hypotheses": ["string"],
  "missingInformation": ["string"]
}

Informations du projet :
Nom : ${input.projectName}
Description : ${input.projectDescription}
Localisation : ${input.location}
Client : ${input.clientName}

Début du cahier des charges :
${input.extractedText.slice(0, 15000)}
Fin du cahier des charges.
`;

    return this.callOpenRouterApi({
      prompt,
      maxTokens: 8000,
      systemPrompt:
        'Tu es un assistant d’ingénierie industrielle. Réponds uniquement en JSON valide et en français.',
    });
  }

  private async callOpenRouterForQuote(analysis: AIResult): Promise<AIQuote> {
    const prompt = `
Tu es un ingénieur expert en préparation de devis pour une entreprise tunisienne.

À partir du résumé de projet et des phases de travail ci-dessous, génère un devis détaillé en JSON.

Résumé du projet : ${analysis.resumeProjet}
Phases : ${JSON.stringify(analysis.workPhases)}
Effectifs : ${JSON.stringify(analysis.workforce)}
Durée totale estimée : ${analysis.durationDays} jours

Retourne EXACTEMENT ce format, sans aucun autre champ :
{
  "validUntil": "2026-11-08T00:00:00.000Z",
  "notes": "phrase courte décrivant le devis",
  "lines": [
    {
      "description": "description de la ligne",
      "quantity": 1,
      "unitPrice": 2500,
      "taxRate": 19
    }
  ]
}

RÈGLES STRICTES POUR LE CALCUL DES PRIX ET QUANTITÉS (MARCHÉ TUNISIEN) :
1. Regroupe les travaux par GRAND ENSEMBLE (ex: "Refroidisseur Polytrack", "Concasseur à rouleaux", "Ventilateur", etc.).
2. La quantité (quantity) doit TOUJOURS être de "1" pour chaque grand ensemble. C'est un forfait global.
3. NE MULTIPLIE JAMAIS la quantité par le nombre de pièces mentionnées.
4. Le prix unitaire (unitPrice) doit être une estimation GLOBALE et FORFAITAIRE pour tout le lot de travaux.
5. ⚠️ COHÉRENCE TUNISIENNE : Le coût de la main-d'œuvre est d'environ 180 TND/jour/technicien.
   - Pour un projet de ${analysis.durationDays} jours avec une équipe, le coût main-d'œuvre seul est d'environ ${analysis.durationDays * 600} TND.
   - Ajoute les consommables (15-20%) et la marge (20-30%).
   - Un grand ensemble de maintenance industrielle ne peut PAS coûter moins de 5 000 TND si la durée dépasse 5 jours.
6. "lines" doit contenir au moins 3 lignes cohérentes avec les phases.
7. Chaque quantity = 1, taxRate = 19 [citation:5][citation:11].
8. Ne JAMAIS ajouter de champs comme materials, labor, transport.
9. La date "validUntil" doit être dans le futur.
`;

    const quoteResult = await this.callOpenRouterApi({
      prompt,
      maxTokens: 8000,
      systemPrompt:
        'Tu es un assistant d’ingénierie. Réponds en JSON valide et en français.',
    });

    return quoteResult as AIQuote;
  }

  private async callOpenRouterApi(params: {
    prompt: string;
    maxTokens: number;
    systemPrompt: string;
  }): Promise<any> {
    const { prompt, maxTokens, systemPrompt } = params;
    const apiKey = this.getOpenRouterApiKey();

    const url = `${this.openRouterBaseUrl}/chat/completions`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'LIM ERP Backend',
        },
        signal: AbortSignal.timeout(300_000),
        body: JSON.stringify({
          model: this.openRouterModel,
          temperature: 0.1,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
        }),
      });
    } catch (error) {
      console.error('[OpenRouter] Échec de la requête HTTP.', { error });
      throw new InternalServerErrorException(
        'Impossible de communiquer avec OpenRouter.',
      );
    }

    console.log('[OpenRouter] Statut HTTP :', response.status);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.error('[OpenRouter] Réponse HTTP en erreur :', {
        status: response.status,
        body: errorBody.slice(0, 2000),
      });
      throw new InternalServerErrorException(
        `OpenRouter a répondu avec le statut ${response.status}.`,
      );
    }

    let payload: any;
    try {
      payload = await response.json();
    } catch (error) {
      console.error('[OpenRouter] Impossible de lire la réponse JSON HTTP :', error);
      throw new InternalServerErrorException(
        'Impossible de lire la réponse JSON retournée par OpenRouter.',
      );
    }

    const content = payload.choices?.[0]?.message?.content;

    if (!content?.trim()) {
      console.error('[OpenRouter] Réponse reçue sans contenu exploitable.', payload);
      throw new InternalServerErrorException(
        'OpenRouter a retourné une réponse vide.',
      );
    }

    try {
      const parsed = JSON.parse(content);
      console.log('[OpenRouter] JSON décodé avec succès.');
      return parsed;
    } catch (error) {
      console.error('[OpenRouter] Le contenu généré n’est pas un JSON valide :', error);
      console.error('[OpenRouter] Début du contenu reçu :', content.slice(0, 1500));
      throw new InternalServerErrorException(
        'La réponse d\'OpenRouter ne contient pas de JSON valide.',
      );
    }
  }

  private validateAnalysisResult(result: AIResult): void {
    if (
      !result ||
      typeof result.resumeProjet !== 'string' ||
      !Array.isArray(result.workPhases) ||
      !Array.isArray(result.workforce)
    ) {
      throw new BadRequestException(
        'La réponse IA ne respecte pas le format attendu.',
      );
    }

    for (const phase of result.workPhases) {
      if (typeof phase.name !== 'string' || !phase.name.trim()) {
        throw new BadRequestException(
          'Une phase de travail n\'a pas de nom.',
        );
      }

      phase.durationDays = parseInt(String(phase.durationDays), 10);
      if (isNaN(phase.durationDays) || phase.durationDays < 1) {
        phase.durationDays = 1;
      }

      if (phase.estimatedCost != null) {
        phase.estimatedCost = Number(phase.estimatedCost);
        if (isNaN(phase.estimatedCost) || phase.estimatedCost < 0) {
          phase.estimatedCost = null;
        }
      }
    }

    for (const person of result.workforce) {
      person.quantity = parseInt(String(person.quantity), 10);
      if (isNaN(person.quantity) || person.quantity < 1) {
        person.quantity = 1;
      }
    }

    if (
      result.confidence != null &&
      (!Number.isFinite(result.confidence) ||
        result.confidence < 0 ||
        result.confidence > 100)
    ) {
      result.confidence = 50;
    }
  }

  private validateQuote(quote: AIQuote): void {
    if (!quote || typeof quote !== 'object') {
      throw new BadRequestException(
        "Le devis généré par l'IA est absent ou invalide.",
      );
    }

    const allowedQuoteKeys = ['validUntil', 'notes', 'lines'];
    const actualQuoteKeys = Object.keys(quote);
    const extraQuoteKeys = actualQuoteKeys.filter(
      (key) => !allowedQuoteKeys.includes(key),
    );

    if (extraQuoteKeys.length > 0) {
      throw new BadRequestException(
        `Le devis contient des champs interdits : ${extraQuoteKeys.join(', ')}. ` +
          `Seuls validUntil, notes et lines sont autorisés.`,
      );
    }

    if (
      !quote.validUntil ||
      Number.isNaN(new Date(quote.validUntil).getTime())
    ) {
      throw new BadRequestException(
        "La date de validité du devis généré par l'IA est invalide.",
      );
    }

    if (typeof quote.notes !== 'string' || !quote.notes.trim()) {
      throw new BadRequestException(
        "Les notes du devis généré par l'IA sont invalides.",
      );
    }

    if (!Array.isArray(quote.lines) || quote.lines.length === 0) {
      throw new BadRequestException(
        "Le devis généré par l'IA doit contenir au moins une ligne.",
      );
    }

    for (const line of quote.lines) {
      if (
        typeof line.description !== 'string' ||
        !line.description.trim() ||
        !Number.isFinite(line.quantity) ||
        line.quantity <= 0 ||
        !Number.isFinite(line.unitPrice) ||
        line.unitPrice < 0 ||
        !Number.isFinite(line.taxRate) ||
        line.taxRate < 0
      ) {
        throw new BadRequestException(
          "Une ligne du devis généré par l'IA est invalide.",
        );
      }
    }
  }
}