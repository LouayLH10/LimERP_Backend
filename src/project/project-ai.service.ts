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

  /**
   * Traitement du fichier uploadé directement sur Vercel (Presigned URL)
   */
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
      console.log(`[Project AI] Téléchargement du fichier depuis Vercel Blob : ${blobUrl}`);
      
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
      
      console.log(`[Project AI] ✅ Fichier téléchargé (${fileBuffer.length} octets)`);
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

  /**
   * Télécharger un fichier privé depuis Vercel Blob
   */
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

  /**
   * Récupérer les infos d'une spécification
   */
  async getSpecification(projectId: string) {
    return this.prisma.projectSpecification.findUnique({
      where: { projectId },
    });
  }

  /**
   * Analyser le cahier des charges avec Groq.
   */
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
      console.log(
        `[Project AI] Longueur du cahier des charges : ${specification.extractedText.length} caractères`,
      );
      console.log('[Project AI] Appel à Groq (analyse)...');

      const analysisResult = await this.callGroqForAnalysis({
        projectName: project.name,
        projectDescription: project.description ?? '',
        location: project.location ?? '',
        clientName: (project.client as { name?: string }).name ?? '',
        extractedText: specification.extractedText,
      });

      console.log('[Project AI] Réponse analyse reçue.');
      console.log('[Project AI] Résumé :', {
        resumeProjet: analysisResult?.resumeProjet,
        estimatedPrice: analysisResult?.estimatedPrice,
        durationDays: analysisResult?.durationDays,
        workPhasesCount: analysisResult?.workPhases?.length,
        workforceCount: analysisResult?.workforce?.length,
      });

      console.log('[Project AI] Validation des données (analyse)...');
      this.validateAnalysisResult(analysisResult);
      console.log('[Project AI] Validation analyse terminée.');

      // 👇 LA CORRECTION EST ICI : On utilise l'enum complet
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

      const workPhases = analysisResult.workPhases.map((phase, index) => ({
        name: phase.name,
        description: phase.description ?? null,
        order: phase.order ?? index + 1,
        durationDays: phase.durationDays,
        estimatedCost: phase.estimatedCost ?? null,
      }));

      console.log('[Project AI] Début de la sauvegarde Prisma...', {
        analysisId: analysis.id,
        workPhasesCount: workPhases.length,
        workforceCount: workforce.length,
      });

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
        },
        include: {
          estimation: true,
          workPhases: { orderBy: { order: 'asc' } },
          workforce: true,
        },
      });

      console.log('[Project AI] Analyse sauvegardée avec succès.', {
        analysisId: saved.id,
      });

      let createdQuote: Awaited<
        ReturnType<typeof this.quotesService.create>
      > | null = null;

      try {
        console.log('[Project AI] Appel à Groq (génération du devis)...');
        const quote = await this.callGroqForQuote(analysisResult);

        if (quote && quote.lines?.length > 0) {
          let validUntil = new Date(quote.validUntil);
          if (Number.isNaN(validUntil.getTime()) || validUntil <= new Date()) {
            validUntil = new Date();
            validUntil.setDate(validUntil.getDate() + 30);
          }

          console.log('[Project AI] Création automatique du devis...', {
            clientId: project.clientId,
            projectId: project.id,
            validUntil: validUntil.toISOString(),
            linesCount: quote.lines.length,
          });

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

          console.log('[Project AI] Devis créé automatiquement :', {
            quoteId: createdQuote.id,
            number: createdQuote.number,
            total: createdQuote.total,
            linesCount: createdQuote.lines.length,
          });
        } else {
          console.warn('[Project AI] Devis vide retourné par Groq.');
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
        specification: { select: { id: true, originalName: true } },
      },
    });

    if (!analysis) {
      throw new NotFoundException('Analyse introuvable.');
    }

    return analysis;
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

    // 👇 On dynamise l'enum pour que l'IA propose les nouveaux postes
    const availablePositions = Object.values(EmployeePosition).join(', ');

    const prompt = `
Tu es un ingénieur expert en maintenance industrielle et préparation
de devis pour une entreprise tunisienne.

Analyse le cahier des charges ci-dessous. Le document peut être en
français, en arabe ou en anglais. Réponds toujours en français.

Retourne exclusivement un objet JSON valide, sans Markdown.

Règles :
- N'invente aucune caractéristique technique absente du document.
- Propose les tâches, les phases, la durée et les effectifs nécessaires.
- Les postes (workforce) doivent obligatoirement correspondre à l'une des valeurs de cet enum :
  ${availablePositions}
- Les prix sont des hypothèses indicatives, jamais des tarifs réels garantis.
- La devise est TND.
- Si les données sont insuffisantes, indique-le dans missingInformation.
- estimatedPrice, durationDays, workPhases et workforce doivent être présents.
- estimatedPrice est une estimation globale en TND, pas un prix contractuel.
- La confiance est un nombre entre 0 et 100.
- Ne crée pas de devis commercial définitif.
- Les coûts des phases doivent être des nombres ou null.

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

Règles :
- "lines" doit contenir au moins 3 lignes cohérentes avec les phases.
- Chaque quantity > 0, unitPrice >= 0, taxRate = 19.
- Ne JAMAIS ajouter de champs comme materials, labor, transport.
- La date "validUntil" doit être dans le futur.
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
      !Number.isFinite(result.estimatedPrice) ||
      result.estimatedPrice < 0 ||
      !Number.isInteger(result.durationDays) ||
      result.durationDays < 1 ||
      !Array.isArray(result.workPhases) ||
      !Array.isArray(result.workforce)
    ) {
      throw new BadRequestException(
        'La réponse IA ne respecte pas le format attendu.',
      );
    }

    for (const phase of result.workPhases) {
      if (
        typeof phase.name !== 'string' ||
        !Number.isInteger(phase.durationDays) ||
        phase.durationDays < 1 ||
        (phase.estimatedCost != null &&
          (!Number.isFinite(phase.estimatedCost) || phase.estimatedCost < 0))
      ) {
        throw new BadRequestException(
          'Une phase de travail retournée par l’IA est invalide.',
        );
      }
    }

    for (const person of result.workforce) {
      if (!Number.isInteger(person.quantity) || person.quantity < 1) {
        throw new BadRequestException(
          'Un effectif recommandé par l’IA est invalide.',
        );
      }
    }

    if (
      result.confidence != null &&
      (!Number.isFinite(result.confidence) ||
        result.confidence < 0 ||
        result.confidence > 100)
    ) {
      throw new BadRequestException(
        'La confiance retournée par l’IA doit être comprise entre 0 et 100.',
      );
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

    console.log('[Project AI] Validation du devis généré par l’IA :', quote);

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