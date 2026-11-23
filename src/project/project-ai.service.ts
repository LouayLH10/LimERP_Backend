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

// Import du nouveau module de chiffrage pur
import {
  priceLot,
  round2,
  hoursFactor,
  type PricingRates,
  type PricingContext,
  type PricedLot,
} from './pricing.services';

// Import du schéma Zod
import { analysisSchema, type Analysis } from './analyzes.schema';

// =========================================================
// HELPERS
// =========================================================

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function extractJson(content: string): any {
  const text = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  try {
    return JSON.parse(text);
  } catch {
    // on tente d'isoler l'objet JSON
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('Aucun objet JSON trouvé dans la réponse.');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim();
}

function toInt(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function toStr(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function humanizePosition(value: string): string {
  const text = value.replace(/_/g, ' ').toLowerCase().trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const pct = (value: number): number => Math.round(value * 100);

// =========================================================
// TEMPLATE HTML
// =========================================================

const REPORT_TEMPLATE = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <style>
    /* ... (Ton CSS existant reste inchangé, je l'ai raccourci ici pour la lisibilité) ... */
    body { font-family: 'Cairo', Arial, sans-serif; color: {{style.textColor}}; margin: 0; }
    .page-container { padding: 40px 50px; }
    .header-main { display: flex; justify-content: space-between; margin-bottom: 30px; }
    .doc-bar { background: {{style.primaryColor}}; color: white; padding: 10px 20px; margin-bottom: 24px; display: flex; justify-content: space-between; }
    .kpis { display: flex; gap: 12px; margin-bottom: 26px; }
    .kpi { flex: 1; padding: 12px; background: #f8fafc; border-top: 3px solid {{style.accentColor}}; text-align: center; }
    .section-title { font-size: 17px; color: {{style.primaryColor}}; border-bottom: 2px solid {{style.primaryColor}}; margin: 26px 0 12px 0; }
    .data-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 10px; }
    .data-table th { background: {{style.primaryColor}}; color: white; padding: 7px; text-align: left; }
    .data-table td { padding: 7px; border-bottom: 1px solid #e2e8f0; }
    .total-row td { font-weight: bold; background: #eef2f7; }
    .grand-total-section { margin-top: 28px; padding: 16px; background: #f8fafc; border-left: 4px solid {{style.accentColor}}; }
    .grand-total-row { display: flex; justify-content: space-between; font-size: 20px; font-weight: bold; color: {{style.primaryColor}}; margin-top: 6px; padding-top: 8px; border-top: 1px solid #cbd5e1; }
    footer { margin-top: 40px; font-size: 9px; text-align: center; color: #64748b; }
  </style>
</head>
<body>
  <div class="page-container">
    <div class="header-main">
      <h1 style="color: {{style.primaryColor}}">Rapport de justification</h1>
    </div>
    <div class="doc-bar">
      <h2>Projet : {{project.name}}</h2>
      <span>{{quoteNumber}}</span>
    </div>

    <div class="kpis">
      {{#each report.kpis}}
        <div class="kpi">
          <div style="font-size: 22px; font-weight: bold; color: {{../style.primaryColor}}">{{this.value}}</div>
          <div style="font-size: 11px; color: {{../style.secondaryColor}}">{{this.label}}</div>
        </div>
      {{/each}}
    </div>

    {{#if n.presentation}}
      <h3 class="section-title"><span class="num">{{n.presentation}}</span> Présentation du projet</h3>
      <p>{{report.summary}}</p>
    {{/if}}

    {{#if n.workforce}}
      <h3 class="section-title"><span class="num">{{n.workforce}}</span> Effectifs mobilisés</h3>
      <table class="data-table">
        <thead><tr><th>Poste</th><th>Effectif</th></tr></thead>
        <tbody>
          {{#each report.workforce}}
            <tr><td>{{this.position}}</td><td>{{this.quantity}}</td></tr>
          {{/each}}
          <tr class="total-row"><td>Total</td><td>{{report.workforceTotal}}</td></tr>
        </tbody>
      </table>
    {{/if}}

    <div class="page-break"></div>

    <h3 class="section-title">Bordereau détaillé des prix</h3>
    {{#each priceSchedule.sections}}
      <div style="margin-bottom: 20px;">
        <h4 style="color: {{../style.primaryColor}}">{{this.title}}</h4>
        <table class="data-table">
          <thead>
            <tr><th>Désignation</th><th>Unité</th><th>Qté</th><th>P.U.</th><th>Montant</th></tr>
          </thead>
          <tbody>
            {{#each this.items}}
              <tr>
                <td>{{this.designation}}</td>
                <td>{{this.unit}}</td>
                <td>{{this.quantity}}</td>
                <td>{{this.unitPrice}}</td>
                <td>{{this.amount}}</td>
              </tr>
            {{/each}}
            <tr class="total-row">
              <td colspan="4">Sous-total</td>
              <td>{{this.subtotal}}</td>
            </tr>
          </tbody>
        </table>
      </div>
    {{/each}}

    <div class="grand-total-section">
      <div style="display: flex; justify-content: space-between;"><span>Total HT</span><span>{{priceSchedule.totalGeneral}} DT</span></div>
      <div style="display: flex; justify-content: space-between;"><span>TVA</span><span>{{priceSchedule.totalTva}} DT</span></div>
      <div class="grand-total-row">
        <span>COÛT TOTAL ESTIMATIF (TTC)</span>
        <span>{{priceSchedule.totalTtc}} DT</span>
      </div>
    </div>
  </div>
</body>
</html>
`;

@Injectable()
export class ProjectAiService {
  private readonly openRouterBaseUrl = 'https://openrouter.ai/api/v1';

  private readonly defaultOpenRouterModels = [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'qwen/qwen3.8-27b:free',
    'thinkingmachines/inkling:free',
  ];

  private readonly TVA_RATE = 0.19;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly quotesService: QuotesService,
  ) {}

  // =========================================================
  // PARAMÈTRES DE CHIFFRAGE
  // =========================================================

  private get rates() {
    const n = (key: string, fallback: number): number => {
      const raw = this.config.get<string | number>(key);
      if (raw === undefined || raw === null || raw === '') return fallback;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? value : fallback;
    };

    return {
      mainOeuvre: n('COUT_JOUR_MAIN_OEUVRE', 100),
      heuresSup: n('MAJORATION_HEURES_SUP', 1.5),
      consommables: n('TAUX_CONSOMMABLES', 0.18),
      logementNuit: n('FRAIS_LOGEMENT_PERSONNE_NUIT', 50),
      logistique: n('FRAIS_LOGISTIQUE_PERSONNE_JOUR', 25),
      manutention: {
        grue: n('COUT_JOUR_GRUE', 800),
        chariot: n('COUT_JOUR_CHARIOT', 250),
        nacelle: n('COUT_JOUR_NACELLE', 300),
        echafaudage: n('COUT_JOUR_ECHAFAUDAGE', 150),
        palan: n('COUT_JOUR_PALAN', 60),
        autre: n('COUT_JOUR_MANUTENTION_DEFAUT', 300), // 'defaut' renommé en 'autre'
      },
      aleas: {
        faible: n('TAUX_ALEAS_FAIBLE', 0.05),
        moyen: n('TAUX_ALEAS_MOYEN', 0.1),
        eleve: n('TAUX_ALEAS_ELEVE', 0.15),
      },
      marge: n('TAUX_MARGE', 0.25),
      calage: n('COEFFICIENT_CALAGE', 1),
      maxSpecChars: n('MAX_SPEC_CHARS', 65_000),
    };
  }

  private getOpenRouterApiKey(): string {
    const apiKey = this.config.get<string>('OPENROUTER_API_KEY');
    if (!apiKey?.trim()) {
      throw new InternalServerErrorException(
        "La clé API OpenRouter n'est pas configurée.",
      );
    }
    return apiKey.trim();
  }

  private getOpenRouterModels(): string[] {
    const fromEnv = this.config.get<string>('OPENROUTER_MODELS');
    const models = fromEnv?.split(',').map((m) => m.trim()).filter(Boolean);
    return models && models.length > 0 ? models : this.defaultOpenRouterModels;
  }

  private getBlobToken(): string {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      throw new InternalServerErrorException(
        "Le token BLOB_READ_WRITE_TOKEN n'est pas configuré.",
      );
    }
    return token;
  }

  // =========================================================
  // IMPORT DU CAHIER DES CHARGES
  // =========================================================

  async processSpecificationFromVercel(
    projectId: string,
    blobUrl: string,
    originalName: string,
    mimeType: string,
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new NotFoundException('Projet introuvable.');

    const extension = extname(originalName).toLowerCase();
    if (extension !== '.pdf' && extension !== '.docx') {
      throw new BadRequestException('Format non supporté. Importe un PDF ou DOCX.');
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
    } catch (error) {
      throw new BadRequestException('Impossible de lire le document depuis Vercel Blob.');
    }

    try {
      if (extension === '.pdf') {
        const pdf = await pdfParse(fileBuffer);
        extractedText = pdf.text ?? '';
      } else {
        const resultDocx = await mammoth.extractRawText({ buffer: fileBuffer });
        extractedText = resultDocx.value ?? '';
      }
    } catch (error) {
      throw new BadRequestException('Erreur lors de la lecture du document.');
    }

    extractedText = extractedText.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    if (!extractedText) {
      throw new BadRequestException('Aucun texte extractible. Un OCR peut être nécessaire.');
    }

    const previous = await this.prisma.projectSpecification.findUnique({
      where: { projectId },
      select: { id: true, storagePath: true },
    });

    const specification = await this.prisma.$transaction(async (tx) => {
      await tx.projectAIAnalysis.deleteMany({ where: { projectId } });
      const generatedFileName = blobUrl.split('/').pop() || `${randomUUID()}${extension}`;

      return tx.projectSpecification.upsert({
        where: { projectId },
        create: { projectId, fileName: generatedFileName, originalName, mimeType, fileSize: fileBuffer.length, storagePath: blobUrl, extractedText },
        update: { fileName: generatedFileName, originalName, mimeType, fileSize: fileBuffer.length, storagePath: blobUrl, extractedText },
      });
    });

    if (previous?.storagePath && previous.storagePath !== blobUrl) {
      if (previous.storagePath.includes('.blob.vercel-storage.com/')) {
        await del(previous.storagePath, { token: this.getBlobToken() }).catch(() => {});
      }
    }

    return { message: 'Cahier des charges importé.', specification, extractedCharacters: extractedText.length };
  }

  async getPrivateFile(fileUrl: string): Promise<Buffer> {
    if (!fileUrl.startsWith('https://') || !fileUrl.includes('.blob.vercel-storage.com/')) {
      throw new BadRequestException('URL Blob invalide');
    }
    const result = await get(fileUrl, { access: 'private', token: this.getBlobToken() });
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
    return this.prisma.projectSpecification.findUnique({ where: { projectId } });
  }

  // =========================================================
  // ANALYSE DU PROJET
  // =========================================================

  async analyzeProject(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { client: true, specification: true },
    });

    if (!project) throw new NotFoundException('Projet introuvable.');

    const specification = project.specification;
    if (!specification?.extractedText?.trim()) {
      throw new BadRequestException('Importe d’abord un cahier des charges contenant du texte.');
    }

    const analysis = await this.prisma.projectAIAnalysis.create({
      data: { projectId, specificationId: specification.id, status: 'PROCESSING' },
    });

    try {
      // 1) Analyse IA avec validation Zod + Retry
      const analysisResult = await this.analyzeWithRetry({
        projectName: project.name,
        projectDescription: project.description ?? '',
        location: project.location ?? '',
        clientName: (project.client as { name?: string })?.name ?? '',
        extractedText: specification.extractedText,
      });

      // 2) Hypothèses complémentaires
      const hypotheses = [...analysisResult.hypotheses];
      if (analysisResult.accommodation === 'non_precise') {
        hypotheses.push("Logement non précisé dans le document : chiffré à la charge de l'entreprise.");
      }
      if (analysisResult.transport === 'non_precise') {
        hypotheses.push("Transport non précisé dans le document : chiffré à la charge de l'entreprise.");
      }

      // 3) CHIFFRAGE (via pricing.services.ts)
      const r = this.rates;
      const ctx: PricingContext = {
        rates: r as unknown as PricingRates,
        hoursFactor: hoursFactor(analysisResult.workingHoursPerDay, r.heuresSup),
        riskRate: r.aleas[analysisResult.riskLevel],
        accommodation: analysisResult.accommodation,
        transport: analysisResult.transport,
      };

      const pricedLots = analysisResult.lots.map((lot) => priceLot(lot, ctx));
      const totalHT = round2(pricedLots.reduce((sum, lot) => sum + lot.total, 0));
      const totalTVA = round2(totalHT * this.TVA_RATE);
      const totalTTC = round2(totalHT + totalTVA);

      // 4) Sauvegarde
      const saved = await this.prisma.projectAIAnalysis.update({
        where: { id: analysis.id },
        data: {
          status: 'COMPLETED',
          summary: analysisResult.resumeProjet,
          assumptions: JSON.stringify(hypotheses),
          missingInformation: JSON.stringify(analysisResult.missingInformation),
          rawResponse: JSON.stringify({
            analysis: analysisResult,
            pricing: {
              riskRate: ctx.riskRate,
              mainOeuvreRate: r.mainOeuvre,
              lots: pricedLots,
            },
          }),
          estimation: {
            create: {
              estimatedPrice: totalHT,
              minPrice: round2(totalHT * 0.85),
              maxPrice: round2(totalHT * 1.25),
              durationDays: analysisResult.durationDays,
              minDurationDays: null,
              maxDurationDays: null,
              confidence: analysisResult.confidence,
              currency: analysisResult.currency || 'TND',
            },
          },
          workPhases: {
            create: analysisResult.workPhases.map((phase, index) => ({
              name: phase.name,
              description: phase.description,
              order: phase.order ?? index + 1,
              durationDays: phase.durationDays,
              estimatedCost: 0,
            })),
          },
          workforce: {
            create: analysisResult.workforce.map((w) => ({
              position: w.position as EmployeePosition,
              quantity: w.quantity,
              reason: w.reason,
            })),
          },
          priceSchedule: {
            create: { totalHT, totalTVA, totalTTC },
          },
        },
        include: {
          estimation: true,
          workPhases: { orderBy: { order: 'asc' } },
          workforce: true,
          priceSchedule: true,
        },
      });

      // 5) Création du Devis
let createdQuote: Awaited<ReturnType<QuotesService['create']>> | null = null;
      try {
        const quoteLines = pricedLots.map((lot) => ({
          description: lot.description ? `${lot.name} – ${lot.description}`.slice(0, 250) : lot.name,
          quantity: 1,
          unitPrice: lot.total,
          taxRate: Math.round(this.TVA_RATE * 100),
        }));

        if (quoteLines.length > 0) {
          const validUntil = new Date();
          validUntil.setDate(validUntil.getDate() + 30);

          createdQuote = await this.quotesService.create({
            clientId: project.clientId,
            projectId: project.id,
            validUntil: validUntil.toISOString(),
            notes: `Devis généré par IA pour le projet "${project.name}".`,
            lines: quoteLines,
          });
        }
      } catch (quoteError) {
        console.error('[Project AI] Impossible de créer le devis :', quoteError);
      }

      return {
        ...saved,
        quote: createdQuote,
        hypotheses,
      };

    } catch (error) {
      await this.prisma.projectAIAnalysis.update({
        where: { id: analysis.id },
        data: { status: 'FAILED' },
      }).catch(() => {});

      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException('Échec de l’analyse IA.');
    }
  }

  // =========================================================
  // APPEL OPENROUTER & RETRY ZOD
  // =========================================================

  private async analyzeWithRetry(input: {
    projectName: string;
    projectDescription: string;
    location: string;
    clientName: string;
    extractedText: string;
  }): Promise<Analysis> {
    const r = this.rates;
    const availablePositions = Object.values(EmployeePosition).join(', ');

    const systemPrompt = `
Ingénieur senior en maintenance industrielle (Tunisie). Tu produis une analyse technique JSON pour un devis.

RÈGLES DE CHIFFRAGE (appliquées par le backend) :
- Main-d'œuvre = Σ(staff.quantity) × durationDays × ${r.mainOeuvre} TND
- Consommables = ${pct(r.consommables)} % de la MO
- Logement = ${r.logementNuit} TND/nuit/personne (sauf si "client")
- Logistique = ${r.logistique} TND/jour/personne (sauf si "client")
- Manutention = forfait journalier par type (grue, chariot, nacelle, etc.)
- Aléas = ${pct(r.aleas.faible)}% / ${pct(r.aleas.moyen)}% / ${pct(r.aleas.eleve)}% selon riskLevel
- Marge = ${pct(r.marge)} %

TU NE PRODUIS AUCUN PRIX. Uniquement des quantités justifiées.

RÈGLES :
- 1 lot = 1 ensemble technique. Pas de doublons.
- staff = TOUS les employés (pas seulement techniciens).
- handling : utilise un "kind" parmi grue|chariot|nacelle|echafaudage|palan|autre.
- Phases = planning, lots = chiffrage. Ne pas additionner.
- Postes autorisés : ${availablePositions}

Réponds uniquement en JSON.
`.trim();

    const { text: specText } = this.prepareSpecText(input.extractedText);

    const prompt = `
ANALYSE TECHNIQUE

Nom : ${input.projectName}
Description : ${input.projectDescription}
Localisation : ${input.location}
Client : ${input.clientName}

FORMAT JSON OBLIGATOIRE
(Respecte scrupuleusement le schéma Zod fourni)

<cahier_des_charges>
${specText}
</cahier_des_charges>
`;

    const firstTry = await this.callOpenRouterApi({ prompt, systemPrompt, maxTokens: 16000 });
    const parsed = analysisSchema.safeParse(firstTry);

    if (parsed.success) return parsed.data;

    // Deuxième essai guidé par les erreurs de Zod
    console.warn('[Project AI] Réponse invalide, nouvel essai avec correction Zod...', parsed.error.issues);
    
    const retryPrompt = `${prompt}\n\nTa réponse précédente est invalide :\n${JSON.stringify(parsed.error.issues)}\nRéponse précédente :\n${JSON.stringify(firstTry)}\nCorrige et renvoie un JSON valide.`;
    
    const secondTry = await this.callOpenRouterApi({ prompt: retryPrompt, systemPrompt, maxTokens: 16000 });
    const finalParsed = analysisSchema.safeParse(secondTry);

    if (finalParsed.success) return finalParsed.data;

    throw new BadRequestException(`L'IA n'a pas produit un JSON valide après 2 essais. Erreur: ${finalParsed.error.message}`);
  }

  private prepareSpecText(text: string): { text: string; truncated: boolean } {
    const max = this.rates.maxSpecChars;
    if (text.length <= max) return { text, truncated: false };
    const tailSize = Math.floor(max * 0.4);
    const headSize = max - tailSize;
    return {
      text: `${text.slice(0, headSize)}\n\n[... partie centrale omise ...]\n\n${text.slice(-tailSize)}`,
      truncated: true,
    };
  }

  private async callOpenRouterApi(params: {
    prompt: string;
    systemPrompt: string;
    maxTokens: number;
  }): Promise<any> {
    const { prompt, systemPrompt, maxTokens } = params;
    const apiKey = this.getOpenRouterApiKey();
    const url = `${this.openRouterBaseUrl}/chat/completions`;
    const referer = this.config.get<string>('APP_URL') ?? 'http://localhost:3000';

    let lastError = 'erreur inconnue';

    for (const model of this.getOpenRouterModels()) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const useJsonMode = attempt === 1;
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              'HTTP-Referer': referer,
              'X-Title': 'LIM ERP Backend',
            },
            signal: AbortSignal.timeout(300_000),
            body: JSON.stringify({
              model,
              temperature: 0,
              max_tokens: maxTokens,
              ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt },
              ],
            }),
          });

          if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            lastError = `${model}: HTTP ${response.status} ${errorBody.slice(0, 300)}`;
            if ([401, 402, 403].includes(response.status)) throw new InternalServerErrorException(`OpenRouter refusé (${response.status}).`);
            if (response.status === 404) break;
            if (response.status === 429) await sleep(4000 * attempt);
            continue;
          }

          const payload: any = await response.json();
          const content: string = payload.choices?.[0]?.message?.content ?? '';
          if (!content.trim()) continue;

          return extractJson(content);
        } catch (error: any) {
          if (error instanceof InternalServerErrorException) throw error;
          lastError = `${model}: ${error?.message ?? error}`;
        }
      }
    }
    throw new InternalServerErrorException(`OpenRouter : aucune réponse exploitable (${lastError}).`);
  }

  // =========================================================
  // PDF
  // =========================================================

  async generatePriceSchedulePdf(analysisId: string, projectId: string): Promise<Buffer> {
    const analysis = await this.prisma.projectAIAnalysis.findUnique({
      where: { id: analysisId },
      include: {
        specification: { include: { project: { include: { client: true } } } },
        workPhases: { orderBy: { order: 'asc' } },
        workforce: true,
        estimation: true,
      },
    });

    if (!analysis || (projectId && analysis.projectId !== projectId)) throw new NotFoundException('Analyse introuvable.');
    
    const project = analysis.specification.project;
    const quote = await this.prisma.quote.findFirst({
      where: { projectId: analysis.projectId },
      include: { lines: true },
    });

    if (!quote) throw new NotFoundException('Devis introuvable.');

    const { analysis: storedAnalysis, pricing } = JSON.parse(analysis.rawResponse as string || '{}');
    const quoteLines = quote.lines as any[];

    const formatMoney = (value: unknown): string => Number(value ?? 0).toLocaleString('fr-TN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
    const formatQty = (value: number): string => Number.isInteger(value) ? String(value) : String(round2(value));

    let totalHT = 0;
    let totalTva = 0;

    const sections = quoteLines.map((quoteLine, index) => {
      const lineTotalHT = round2(Number(quoteLine.unitPrice) * Number(quoteLine.quantity));
      totalHT += lineTotalHT;
      totalTva += lineTotalHT * ((Number(quoteLine.taxRate) || 0) / 100);

      const pricedLot = pricing?.lots?.find((l: PricedLot) => normalizeKey(l.name) === normalizeKey(quoteLine.description));
      
      const items = pricedLot ? [
        { designation: "Main-d'œuvre", unit: 'jour-homme', quantity: pricedLot.quantities.personDays, unitPrice: formatMoney(pricedLot.components.labour / (pricedLot.quantities.personDays || 1)), amount: formatMoney(pricedLot.components.labour) },
        { designation: 'Consommables', unit: 'forfait', quantity: 1, unitPrice: formatMoney(pricedLot.components.consumables), amount: formatMoney(pricedLot.components.consumables) },
        { designation: 'Logistique & Hébergement', unit: 'forfait', quantity: 1, unitPrice: formatMoney(pricedLot.components.accommodation + pricedLot.components.logistics), amount: formatMoney(pricedLot.components.accommodation + pricedLot.components.logistics) },
        ...(pricedLot.components.handling > 0 ? [{ designation: 'Manutention', unit: 'forfait', quantity: 1, unitPrice: formatMoney(pricedLot.components.handling), amount: formatMoney(pricedLot.components.handling) }] : []),
      ] : [{ designation: quoteLine.description, unit: 'forfait', quantity: 1, unitPrice: formatMoney(lineTotalHT), amount: formatMoney(lineTotalHT) }];

      return { title: `${index + 1}. ${quoteLine.description}`, items, subtotal: formatMoney(lineTotalHT) };
    });

    const workforceRows = (analysis.workforce as any[]).map((w) => ({
      position: humanizePosition(String(w.position)),
      quantity: Number(w.quantity) || 0,
    }));

    const kpis = [
      { label: 'Durée', value: `${analysis.estimation?.durationDays || '-'} j` },
      { label: 'Effectif', value: String(workforceRows.reduce((s, w) => s + w.quantity, 0)) },
      { label: 'Lots', value: String(sections.length) },
    ];

    const templateData = {
      project: { name: project.name },
      quoteNumber: quote.number,
      report: { summary: analysis.summary, kpis, workforce: workforceRows, workforceTotal: workforceRows.reduce((s, w) => s + w.quantity, 0) },
      priceSchedule: { sections, totalGeneral: formatMoney(totalHT), totalTva: formatMoney(totalTva), totalTtc: formatMoney(totalHT + totalTva) },
      n: { presentation: 1, workforce: 2, bordereau: 3 },
      style: { primaryColor: '#1F2937', secondaryColor: '#6B7280', accentColor: '#2563EB', textColor: '#111827' },
    };

    const html = Handlebars.compile(REPORT_TEMPLATE)(templateData);
    const puppeteer = (await import('puppeteer-core')).default;
    const chromium = (await import('@sparticuz/chromium')).default;
    const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath() });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: 45_000 });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' } });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }
}