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
  private readonly groqBaseUrl = 'https://api.groq.com/openai/v1';
  private readonly groqModel = 'openai/gpt-oss-120b';

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly quotesService: QuotesService,
  ) {}

  private getGroqApiKey(): string {
    const apiKey = this.config.get<string>('GROQ_API');
    if (!apiKey?.trim()) {
      throw new InternalServerErrorException(
        "La clé API Groq n'est pas configurée. Ajoute GROQ_API dans le fichier .env.",
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

      const analysisResult = await this.callGroqForAnalysis({
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

      let totalHT = 0;
      const workPhases = analysisResult.workPhases.map((phase, index) => {
        // 👇 On s'assure d'avoir un coût minimum par phase (ex: 1000 TND / jour)
        const baseCost = phase.durationDays * 1500; 
        const estimatedCost = phase.estimatedCost ?? baseCost;
        totalHT += estimatedCost;

        return {
          name: phase.name,
          description: phase.description ?? null,
          order: phase.order ?? index + 1,
          durationDays: phase.durationDays,
          estimatedCost: estimatedCost,
        };
      });

      const tvaRate = 0.19;
      const totalTVA = totalHT * tvaRate;
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
        const quote = await this.callGroqForQuote(analysisResult);

        if (quote && quote.lines?.length > 0) {
          let validUntil = new Date(quote.validUntil);
          if (Number.isNaN(validUntil.getTime()) || validUntil <= new Date()) {
            validUntil = new Date();
            validUntil.setDate(validUntil.getDate() + 30);
          }

          createdQuote = await this.quotesService.create({
            clientId: project.clientId,
            projectId: project.id,
            validUntil: validUntil.toISOString(),
            notes:
              quote.notes?.trim() ||
              `Devis généré automatiquement par IA pour le projet "${project.name}".`,
            lines: quote.lines.map((line) => ({
              description: line.description.trim(),
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              taxRate: line.taxRate,
            })),
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
          'Estimation indicative générée par IA. Les tarifs et quantités doivent être validés avant la création du devis.',
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
        priceSchedule: true,
        workPhases: { orderBy: { order: 'asc' } },
        estimation: true,
        specification: { 
          include: { 
            project: { 
              include: { client: true } 
            } 
          } 
        }
      }
    });

    if (!analysis || !analysis.priceSchedule) {
      throw new NotFoundException('Bordereau de prix introuvable pour cette analyse.');
    }

    const project = analysis.specification.project;
    const client = project.client;

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
            padding-bottom: 140px;
          }
          .watermark {
            position: fixed; top: 50%; left: 50%;
            transform: translate(-50%, -50%) rotate(-30deg);
            font-size: 150px; font-weight: bold;
            color: {{style.primaryColor}}; opacity: 0.04;
            z-index: -1; letter-spacing: 10px; white-space: nowrap;
          }
          .page-container { padding: 40px 50px; }
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
          .info-section { display: flex; justify-content: space-between; margin-bottom: 40px; }
          .client-info { width: 45%; background: #f8fafc; padding: 15px; border-radius: {{style.borderRadius}}px; border-left: 4px solid {{style.accentColor}}; }
          .client-info h3 { margin: 0 0 10px 0; font-size: 14px; color: {{style.secondaryColor}}; text-transform: uppercase; }
          .client-info p { margin: 3px 0; font-size: 13px; }
          .project-info { width: 45%; text-align: right; }
          .project-info p { margin: 5px 0; font-size: 13px; }
          .project-info strong { color: {{style.primaryColor}}; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
          th { background: {{style.primaryColor}}; color: white; padding: 12px; text-align: left; font-size: 13px; text-transform: uppercase; }
          td { padding: 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px; }
          tr { page-break-inside: avoid; }
          thead { display: table-header-group; }
          .text-right { text-align: right; }
          .text-center { text-align: center; }
          .totals-wrapper {
            page-break-inside: avoid;
            break-inside: avoid;
            margin-top: 10px;
          }
          .totals { width: 40%; margin-left: auto; }
          .totals table { margin-bottom: 0; }
          .totals td { padding: 8px 12px; }
          .totals .total-row { background: {{style.primaryColor}}; color: white; font-weight: bold; font-size: 15px; }
          .totals .total-row td { border-bottom: none; }
          footer {
            position: fixed; bottom: 0; left: 0; right: 0;
            padding: 15px 50px; background: {{style.backgroundColor}};
            border-top: 1px solid #e2e8f0; font-size: 9px;
            text-align: center; color: #64748b; line-height: 1.5; z-index: 100;
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
            <h2>BORDEREAU DE PRIX DÉTAILLÉ</h2>
            <span class="doc-number">Projet : {{project.name}}</span>
          </div>
          <div class="info-section">
            <div class="client-info">
              <h3>Client</h3>
              <p><strong>{{client.companyName}}</strong></p>
              {{#if client.address}}<p>{{client.address}}</p>{{/if}}
              {{#if client.phone}}<p>Tél : {{client.phone}}</p>{{/if}}
            </div>
            <div class="project-info">
              <p><strong>Date d'analyse :</strong> {{analysisDate}}</p>
              <p><strong>Durée estimée :</strong> {{durationDays}} jours</p>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Désignation des travaux</th>
                <th class="text-center">Durée</th>
                <th class="text-right">Montant HT</th>
              </tr>
            </thead>
            <tbody>
              {{#each workPhases}}
              <tr>
                <td>{{this.order}}</td>
                <td>
                  <strong>{{this.name}}</strong>
                  {{#if this.description}}<br><small style="color:#64748b">{{this.description}}</small>{{/if}}
                </td>
                <td class="text-center">{{this.durationDays}} j</td>
                <td class="text-right">{{this.estimatedCost}} TND</td>
              </tr>
              {{/each}}
            </tbody>
          </table>
          <div class="totals-wrapper">
            <div class="totals">
              <table>
                <tr><td>Total HT</td><td class="text-right">{{totalHT}} TND</td></tr>
                <tr><td>TVA (19%)</td><td class="text-right">{{totalTVA}} TND</td></tr>
                <tr class="total-row"><td>Total TTC</td><td class="text-right">{{totalTTC}} TND</td></tr>
              </table>
            </div>
          </div>
        </div>
        <footer>
          <div class="company-name"><bdi>شركة لؤي للصناعة و الصيانة</bdi> - SOCIETE LOUAY INDUSTRIE ET MAINTENANCE</div>
          <div>Rue Ali Dargouth, Imm El Moustakbal 5, 1001 Tunis 1er étage BN 10 | Bureaux de Gabès : N° 08 Rue al anbar, 1er étage Gabès Ville 6040</div>
          <div>Tel fixe : 00 216 70038568 | GSM : (00216) 28 815 988 | Mail : lim_commercial@outlook.com / samirhcine@hotmail.com</div>
          <div>WWW.LIM.TN | SARL Capital 210 000 DT | Code TVA 929854/AAM/000</div>
        </footer>
      </body>
      </html>
    `;

    const formatMoney = (value: number | string | any | null | undefined): string =>
      Number(value ?? 0).toLocaleString('fr-TN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

    const templateData = {
      project: { name: project.name },
      client: { 
        companyName: client.companyName, 
        address: client.address, 
        phone: client.phone 
      },
      analysisDate: new Date(analysis.createdAt).toLocaleDateString('fr-FR'),
      durationDays: analysis.estimation?.durationDays || 0,
      workPhases: analysis.workPhases.map(phase => ({
        ...phase,
        estimatedCost: formatMoney(phase.estimatedCost)
      })),
      totalHT: formatMoney(analysis.priceSchedule.totalHT),
      totalTVA: formatMoney(analysis.priceSchedule.totalTVA),
      totalTTC: formatMoney(analysis.priceSchedule.totalTTC),
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

  private async callGroqForAnalysis(input: {
    projectName: string;
    projectDescription: string;
    location: string;
    clientName: string;
    extractedText: string;
  }): Promise<AIResult> {
    const apiKey = this.getGroqApiKey();
    const url = `${this.groqBaseUrl}/chat/completions`;

    const availablePositions = Object.values(EmployeePosition).join(', ');

    const prompt = `
Tu es un ingénieur expert en maintenance industrielle et préparation
de devis pour une entreprise tunisienne.

Analyse le cahier des charges ci-dessous. Le document peut être en
français, en arabe ou en anglais. Réponds toujours en français.

Retourne exclusivement un objet JSON valide, sans Markdown.

RÈGLES STRICTES POUR L'ESTIMATION DES COÛTS ET DURÉES :
1. Si le document mentionne une durée d'arrêt (ex: 18 jours) et des horaires (ex: 12h/jour), tu DOIS utiliser ces données.
2. Pour estimer le coût d'une phase, base-toi sur le nombre de jours x 12h x 3 techniciens x (taux horaire moyen de 35 TND) = environ 1500 TND par jour.
3. N'invente pas de prix trop bas. Un grand ensemble industriel coûte au minimum 10 000 TND en main-d'œuvre.
4. Propose les tâches, les phases, la durée et les effectifs nécessaires.
5. Les postes (workforce) doivent obligatoirement correspondre à l'une des valeurs de cet enum :
  ${availablePositions}
6. Si les données sont insuffisantes, indique-le dans missingInformation.
7. estimatedPrice, durationDays, workPhases et workforce doivent être présents.

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

    return this.callGroqApi({
      url,
      apiKey,
      prompt,
      maxTokens: 3000,
      model: this.groqModel,
      systemPrompt:
        'Tu es un assistant d’ingénierie industrielle. Réponds uniquement en JSON valide et en français.',
    });
  }

  /**
   * 👇 PROMPT DU DEVIS CORRIGÉ POUR ÉVITER LES ERREURS DE CALCUL ET AUGMENTER LES PRIX
   */
  private async callGroqForQuote(analysis: AIResult): Promise<AIQuote> {
    const apiKey = this.getGroqApiKey();
    const url = `${this.groqBaseUrl}/chat/completions`;

    const prompt = `
Tu es un ingénieur expert en préparation de devis pour une entreprise tunisienne.

À partir du résumé de projet et des phases de travail ci-dessous, génère un devis détaillé en JSON.

Résumé du projet : ${analysis.resumeProjet}
Phases : ${JSON.stringify(analysis.workPhases)}
Effectifs : ${JSON.stringify(analysis.workforce)}

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

RÈGLES STRICTES POUR LE CALCUL DES PRIX ET QUANTITÉS (TRÈS IMPORTANT) :
1. Regroupe les travaux par GRAND ENSEMBLE (ex: "Refroidisseur Polytrack", "Concasseur à rouleaux", "Ventilateur", etc.).
2. La quantité (quantity) doit TOUJOURS être de "1" pour chaque grand ensemble. C'est un forfait global.
3. NE MULTIPLIE JAMAIS la quantité par le nombre de pièces mentionnées (ex: s'il y a 12 vérins ou 9 ventilateurs, ne fais pas 1 x 12 ou 1 x 9). Le prix unitaire doit déjà englober la totalité des pièces du lot.
4. Le prix unitaire (unitPrice) doit être une estimation GLOBALE et FORFAITAIRE pour tout le lot de travaux, et non un prix à l'unité.
5. ⚠️ ATTENTION : Un grand ensemble de maintenance industrielle coûte AU MINIMUM 15 000 TND (main-d'œuvre + outillage + risques). Si tu mets moins de 10 000 TND, ton estimation est fausse.
6. "lines" doit contenir au moins 3 lignes cohérentes avec les phases.
7. Chaque quantity = 1, unitPrice >= 15000, taxRate = 19.
8. Ne JAMAIS ajouter de champs comme materials, labor, transport.
9. La date "validUntil" doit être dans le futur.
`;

    const quoteResult = await this.callGroqApi({
      url,
      apiKey,
      prompt,
      maxTokens: 2000,
      model: this.groqModel,
      systemPrompt:
        'Tu es un assistant d’ingénierie. Réponds en JSON valide et en français.',
    });

    return quoteResult as AIQuote;
  }

  private async callGroqApi(params: {
    url: string;
    apiKey: string;
    prompt: string;
    maxTokens: number;
    model: string;
    systemPrompt: string;
  }): Promise<any> {
    const { url, apiKey, prompt, maxTokens, model, systemPrompt } = params;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
        }),
      });
    } catch (error) {
      console.error('[Groq] Échec de la requête HTTP.', {
        url,
        model,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, cause: error.cause }
            : error,
      });
      throw new InternalServerErrorException(
        'Impossible de communiquer avec Groq ou délai d’attente dépassé.',
      );
    }

    console.log('[Groq] Statut HTTP :', response.status);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.error('[Groq] Réponse HTTP en erreur :', {
        status: response.status,
        body: errorBody.slice(0, 2000),
      });

      if (response.status === 401) {
        throw new InternalServerErrorException(
          'Clé API Groq invalide. Vérifie GROQ_API dans le fichier .env.',
        );
      }
      if (response.status === 429) {
        throw new InternalServerErrorException(
          'Limite de débit Groq atteinte. Réessaie dans quelques instants.',
        );
      }
      if (response.status === 413) {
        throw new InternalServerErrorException(
          'Requête trop volumineuse pour Groq. Réduis la taille du cahier des charges.',
        );
      }

      throw new InternalServerErrorException(
        `Groq a répondu avec le statut ${response.status}. Consulte les logs pour plus de détails.`,
      );
    }

    let payload: {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };

    try {
      payload = (await response.json()) as typeof payload;
    } catch (error) {
      console.error('[Groq] Impossible de lire la réponse JSON HTTP :', error);
      throw new InternalServerErrorException(
        'Impossible de lire la réponse JSON retournée par Groq.',
      );
    }

    if (payload.error?.message) {
      console.error(
        '[Groq] Erreur signalée par le serveur :',
        payload.error.message,
      );
      throw new InternalServerErrorException(
        'Groq a signalé une erreur pendant la génération.',
      );
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content?.trim()) {
      console.error('[Groq] Réponse reçue sans contenu exploitable.', payload);
      throw new InternalServerErrorException(
        'Groq a retourné une réponse vide.',
      );
    }

    try {
      const parsed = JSON.parse(content);
      console.log('[Groq] JSON décodé avec succès.');
      return parsed;
    } catch (error) {
      console.error(
        '[Groq] Le contenu généré n’est pas un JSON valide :',
        error,
      );
      console.error('[Groq] Début du contenu reçu :', content.slice(0, 1500));
      throw new InternalServerErrorException(
        'La réponse de Groq ne contient pas de JSON valide. Essaie de relancer l’analyse.',
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