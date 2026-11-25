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

// =========================================================
// TYPES
// =========================================================

type AIPhaseStaff = {
  position: string;
  quantity: number;
};

type AIWorkPhase = {
  name: string;
  description: string | null;
  order: number;
  durationDays: number;
  staff: AIPhaseStaff[];
};

type AIPreparation = {
  name: string;
  description: string | null;
};

type AIHandlingEquipment = {
  name: string;
  days: number;
};

type AILot = {
  name: string;
  description: string | null;
  durationDays: number;
  staff: AIPhaseStaff[];
  handlingEquipment: AIHandlingEquipment[];
};

type AIWorkforce = {
  position: string;
  quantity: number;
  reason: string | null;
};

type Arrangement = 'client' | 'entreprise' | 'non_precise';

type RiskLevel = 'faible' | 'moyen' | 'eleve';

type AIResult = {
  resumeProjet: string;
  durationDays: number;
  minDurationDays: number | null;
  maxDurationDays: number | null;
  workingHoursPerDay: number | null;
  confidence: number | null;
  currency: string;
  accommodation: Arrangement;
  transport: Arrangement;
  riskLevel: RiskLevel;
  riskReasons: string[];
  evidence: string[];
  preparations: AIPreparation[];
  lots: AILot[];
  workPhases: AIWorkPhase[];
  workforce: AIWorkforce[];
  hypotheses: string[];
  missingInformation: string[];
};

type CostComponents = {
  labour: number;
  consumables: number;
  accommodation: number;
  logistics: number;
  handling: number;
};

type LotQuantities = {
  labourPersonDays: number;
  accommodationPersonNights: number;
  logisticsPersonDays: number;
};

type HandlingLine = { name: string; days: number; base: number };

type PricedLot = AILot & {
  quoteDescription: string;
  total: number;
  components: CostComponents;
  quantities: LotQuantities;
  handling: HandlingLine[];
  headcount: number;
};

type StoredLot = {
  name: string;
  description?: string | null;
  quoteDescription: string;
  total: number;
  components: CostComponents;
  durationDays?: number;
  headcount?: number;
  quantities?: LotQuantities;
  handling?: HandlingLine[];
  staff?: AIPhaseStaff[];
};

type PriceItem = { description: string; weight: number };

type DetailLine = {
  designation: string;
  unit: string;
  quantity: number;
  weight: number;
};

// =========================================================
// HELPERS
// =========================================================

const round2 = (value: number): number => Math.round(value * 100) / 100;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function toInt(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function toStr(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => (v as string).trim());
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim();
}

function allocateByWeights(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const parts = weights.map((w) => round2((total * w) / sum));
  const diff = round2(total - parts.reduce((a, b) => a + b, 0));
  if (parts.length > 0) {
    parts[parts.length - 1] = round2(parts[parts.length - 1] + diff);
  }
  return parts;
}

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

function toArrangement(value: unknown): Arrangement {
  const text = typeof value === 'string' ? normalizeKey(value) : '';
  if (text.includes('client')) return 'client';
  if (text.includes('entreprise')) return 'entreprise';
  return 'non_precise';
}

function toRiskLevel(value: unknown): RiskLevel {
  const text = typeof value === 'string' ? normalizeKey(value) : '';
  if (text.startsWith('el') || text.includes('high') || text.includes('haut')) {
    return 'eleve';
  }
  if (text.startsWith('faib') || text.includes('low') || text.includes('bas')) {
    return 'faible';
  }
  return 'moyen';
}

function humanizePosition(value: string): string {
  const text = value.replace(/_/g, ' ').toLowerCase().trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function totalStaff(staff: AIPhaseStaff[] | undefined): number {
  if (!Array.isArray(staff)) return 0;
  return staff.reduce(
    (sum, s) => sum + Math.max(0, toInt(s?.quantity, 0)),
    0,
  );
}

// =========================================================
// TEMPLATE HTML DU RAPPORT DE JUSTIFICATION
// =========================================================

const REPORT_TEMPLATE = `
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

          .doc-bar {
            background: {{style.primaryColor}};
            color: white;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 20px;
            border-radius: {{style.borderRadius}}px;
            margin-bottom: 24px;
            gap: 16px;
            flex-wrap: wrap;
          }
          .doc-bar h2 {
            margin: 0;
            font-size: 22px;
            text-transform: uppercase;
            letter-spacing: 2px;
            flex: 1 1 auto;
          }
          .doc-bar .doc-meta {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 6px;
          }
          .doc-bar .doc-number { font-size: 14px; font-weight: bold; }
          .doc-bar .da-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: rgba(255, 255, 255, 0.18);
            border: 1px solid rgba(255, 255, 255, 0.4);
            padding: 3px 10px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 600;
            letter-spacing: 0.5px;
          }
          .doc-bar .da-badge .da-label { opacity: 0.85; font-weight: 400; }

          .info-table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 22px;
            background: #f8fafc;
            border-radius: 6px;
            overflow: hidden;
            font-size: 13px;
          }
          .info-table td {
            padding: 9px 14px;
            border-bottom: 1px solid #e2e8f0;
            vertical-align: top;
          }
          .info-table tr:last-child td { border-bottom: none; }
          .info-table .label {
            color: {{style.secondaryColor}};
            font-weight: 600;
            width: 120px;
            text-transform: uppercase;
            font-size: 11px;
            letter-spacing: 0.5px;
          }
          .info-table .value { color: {{style.textColor}}; font-weight: 500; }

          .kpis { display: flex; gap: 12px; margin-bottom: 26px; }
          .kpi {
            flex: 1;
            padding: 12px 10px;
            text-align: center;
            background: #f8fafc;
            border-top: 3px solid {{style.accentColor}};
            border-radius: 4px;
          }
          .kpi-value { font-size: 22px; font-weight: 700; color: {{style.primaryColor}}; }
          .kpi-label { font-size: 11px; color: {{style.secondaryColor}}; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }

          .section-title {
            font-size: 17px;
            font-weight: 700;
            color: {{style.primaryColor}};
            border-bottom: 2px solid {{style.primaryColor}};
            padding-bottom: 5px;
            margin: 26px 0 12px 0;
            page-break-after: avoid;
          }
          .section-title .num {
            display: inline-block;
            min-width: 24px;
            padding: 1px 7px;
            margin-right: 8px;
            background: {{style.primaryColor}};
            color: white;
            border-radius: 4px;
            text-align: center;
            font-size: 14px;
          }
          .sub { font-size: 13px; font-weight: 600; color: {{style.secondaryColor}}; margin: 14px 0 6px 0; }
          .text { font-size: 13px; line-height: 1.6; margin: 0 0 8px 0; text-align: justify; }

          .data-table { width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 12px; }
          .data-table thead th {
            background: {{style.primaryColor}};
            color: white;
            padding: 7px 8px;
            font-weight: 600;
            text-align: left;
          }
          .data-table td { padding: 7px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
          .data-table tbody tr:nth-child(even) td { background: #f8fafc; }
          .data-table .r { text-align: right; }
          .data-table .c { text-align: center; }
          .data-table .b { font-weight: 700; }
          .data-table tr { page-break-inside: avoid; }
          .data-table .total-row td {
            font-weight: 700;
            color: {{style.primaryColor}};
            background: #eef2f7;
            border-top: 2px solid {{style.primaryColor}};
          }

          .page-break { page-break-before: always; }
          .report-section { margin-bottom: 22px; page-break-inside: avoid; }
          .report-title {
            font-size: 14px;
            font-weight: bold;
            color: {{style.primaryColor}};
            border-bottom: 1px solid #e2e8f0;
            padding-bottom: 4px;
            margin-bottom: 8px;
          }

          .grand-total-section {
            margin-top: 28px;
            padding: 16px 20px;
            background: #f8fafc;
            border-left: 4px solid {{style.accentColor}};
            page-break-inside: avoid;
          }
          .total-line { display: flex; justify-content: space-between; font-size: 14px; padding: 3px 0; }
          .grand-total-row {
            display: flex;
            justify-content: space-between;
            font-size: 20px;
            font-weight: bold;
            color: {{style.primaryColor}};
            border-top: 1px solid #cbd5e1;
            margin-top: 6px;
            padding-top: 8px;
          }

          footer {
            margin-top: auto;
            padding-top: 20px;
            border-top: 1px solid #e2e8f0;
            font-size: 9px;
            text-align: center;
            color: #64748b;
            line-height: 1.5;
          }
          footer .company-name {
            font-weight: bold;
            color: {{style.primaryColor}};
            font-size: 11px;
            margin-bottom: 5px;
          }
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
            <h2>Rapport de justification du devis</h2>
            <div class="doc-meta">
              <span class="doc-number">Projet : {{project.name}}</span>
              {{#if project.daNumber}}
                <span class="da-badge">
                  <span class="da-label">DA N°</span>
                  {{project.daNumber}}
                </span>
              {{/if}}
            </div>
          </div>

          <table class="info-table">
            <tr>
              <td class="label">Devis N°</td>
              <td class="value">{{quoteNumber}}</td>
              <td class="label">Date</td>
              <td class="value">{{generatedAt}}</td>
            </tr>
            <tr>
              <td class="label">Projet</td>
              <td class="value">{{project.name}}</td>
              <td class="label">DA</td>
              <td class="value">{{#if project.daNumber}}{{project.daNumber}}{{else}}—{{/if}}</td>
            </tr>
            <tr>
              <td class="label">Client</td>
              <td class="value">{{project.clientName}}</td>
              <td class="label">Lieu</td>
              <td class="value">{{project.location}}</td>
            </tr>
          </table>

          <div class="kpis">
            {{#each report.kpis}}
              <div class="kpi">
                <div class="kpi-value">{{this.value}}</div>
                <div class="kpi-label">{{this.label}}</div>
              </div>
            {{/each}}
          </div>

          {{#if n.presentation}}
            <h3 class="section-title"><span class="num">{{n.presentation}}</span>Présentation du projet</h3>
            <p class="text">{{report.summary}}</p>
            <p class="text">
              Le présent rapport détaille les moyens mobilisés et la répartition des coûts du devis <strong>N° {{quoteNumber}}</strong>{{#if project.daNumber}} rattaché au DA <strong>{{project.daNumber}}</strong>{{/if}}. Les prix forfaitaires sont justifiés par des charges réelles de main-d'œuvre, de consommables, d'hébergement, de logistique et de moyens de manutention.
            </p>
          {{/if}}

          {{#if n.workforce}}
            <h3 class="section-title"><span class="num">{{n.workforce}}</span>Effectifs mobilisés</h3>

            {{#if report.workforce.length}}
              <table class="data-table">
                <thead><tr><th>Poste</th><th class="r" style="width:110px">Effectif</th></tr></thead>
                <tbody>
                  {{#each report.workforce}}
                    <tr><td>{{this.position}}</td><td class="r">{{this.quantity}}</td></tr>
                  {{/each}}
                  <tr class="total-row"><td>Effectif de pointe</td><td class="r">{{report.workforceTotal}}</td></tr>
                </tbody>
              </table>
            {{/if}}

            {{#if report.lotTeams.length}}
              <p class="sub">Équipes affectées à chaque lot de travaux</p>
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Lot</th>
                    <th>Composition de l'équipe</th>
                    <th class="c">Effectif</th>
                    <th class="c">Jours</th>
                    <th class="c">Jours-homme</th>
                    <th>Moyens de manutention</th>
                  </tr>
                </thead>
                <tbody>
                  {{#each report.lotTeams}}
                    <tr>
                      <td>{{this.name}}</td>
                      <td>{{this.composition}}</td>
                      <td class="c b">{{this.persons}}</td>
                      <td class="c">{{this.days}}</td>
                      <td class="c">{{this.personDays}}</td>
                      <td>{{this.handling}}</td>
                    </tr>
                  {{/each}}
                  <tr class="total-row">
                    <td>Total</td>
                    <td></td>
                    <td class="c">{{report.lotTotals.persons}}</td>
                    <td class="c">—</td>
                    <td class="c">{{report.lotTotals.personDays}}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            {{/if}}
          {{/if}}

          {{#if n.preparation}}
            <h3 class="section-title"><span class="num">{{n.preparation}}</span>Préparation du chantier</h3>
            <table class="data-table">
              <thead><tr><th style="width:40px" class="c">N°</th><th style="width:200px">Action de préparation</th><th>Détail</th></tr></thead>
              <tbody>
                {{#each report.preparations}}
                  <tr>
                    <td class="c">{{this.index}}</td>
                    <td class="b">{{this.name}}</td>
                    <td>{{this.description}}</td>
                  </tr>
                {{/each}}
              </tbody>
            </table>
          {{/if}}

          {{#if n.planning}}
            <h3 class="section-title"><span class="num">{{n.planning}}</span>Planning des travaux</h3>
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width:40px" class="c">N°</th>
                  <th style="width:170px">Phase</th>
                  <th>Contenu</th>
                  <th class="c" style="width:60px">Durée (j)</th>
                  <th class="c" style="width:110px">Effectif</th>
                </tr>
              </thead>
              <tbody>
                {{#each report.phases}}
                  <tr>
                    <td class="c">{{this.order}}</td>
                    <td class="b">{{this.name}}</td>
                    <td>{{this.description}}</td>
                    <td class="c">{{this.durationDays}}</td>
                    <td class="c">{{this.staff}}</td>
                  </tr>
                {{/each}}
              </tbody>
            </table>
          {{/if}}

          <div class="page-break"></div>

          <h3 class="section-title" style="margin-top:0"><span class="num">{{n.bordereau}}</span>Bordereau détaillé des prix</h3>

          {{#each priceSchedule.sections}}
            <div class="report-section">
              <div class="report-title">{{this.title}}</div>
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Désignation</th>
                    <th class="c" style="width:80px">Unité</th>
                    <th class="r" style="width:60px">Qté</th>
                    <th class="r" style="width:90px">P.U. (DT)</th>
                    <th class="r" style="width:105px">Montant (DT)</th>
                  </tr>
                </thead>
                <tbody>
                  {{#each this.items}}
                    <tr>
                      <td>{{this.designation}}</td>
                      <td class="c">{{this.unit}}</td>
                      <td class="r">{{this.quantity}}</td>
                      <td class="r">{{this.unitPrice}}</td>
                      <td class="r b">{{this.amount}}</td>
                    </tr>
                  {{/each}}
                  <tr class="total-row">
                    <td colspan="4">Sous-total</td>
                    <td class="r">{{this.subtotal}}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          {{/each}}

          <div class="grand-total-section">
            <div class="total-line"><span>Total HT</span><span>{{priceSchedule.totalGeneral}} DT</span></div>
            <div class="total-line"><span>TVA</span><span>{{priceSchedule.totalTva}} DT</span></div>
            <div class="grand-total-row">
              <span>COÛT TOTAL ESTIMATIF (TTC)</span>
              <span>{{priceSchedule.totalTtc}} DT</span>
            </div>
            <p style="margin-top: 10px; font-size: 12px; color: #64748b;">
              * Prix en dinars tunisiens (DT) – Hors pièces de rechange fournies par le client.
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

const DEFAULT_PRICE_ITEMS: PriceItem[] = [
  { description: "Main d'œuvre mécanique et encadrement", weight: 65 },
  { description: 'Consommables et petites fournitures', weight: 20 },
  { description: 'Logistique, transport et hébergement', weight: 15 },
];

const COMPONENT_LABELS: Record<keyof CostComponents, string> = {
  labour: "Main-d'œuvre (toutes catégories de personnel)",
  consumables: 'Consommables et petites fournitures',
  accommodation: 'Hébergement du personnel',
  logistics: 'Transport, déplacements et repas',
  handling: 'Moyens de manutention et de levage',
};

@Injectable()
export class ProjectAiService {
  private readonly openRouterBaseUrl = 'https://openrouter.ai/api/v1';

  private readonly defaultOpenRouterModels = [
    'openrouter/free',
  ];

  private readonly DEFAULT_LOT_TECHNICIANS = 2;
  private readonly DEFAULT_LOT_LEADERS = 1;

  private readonly FOURCHETTE_BASSE = 0.85;
  private readonly FOURCHETTE_HAUTE = 1.25;

  private readonly TVA_RATE = 0.19;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly quotesService: QuotesService,
  ) {}

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
        defaut: n('COUT_JOUR_MANUTENTION_DEFAUT', 300),
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
        "La clé API OpenRouter n'est pas configurée. Ajoute OPENROUTER_API_KEY dans le fichier .env.",
      );
    }
    return apiKey.trim();
  }

  private getOpenRouterModels(): string[] {
    const fromEnv = this.config.get<string>('OPENROUTER_MODELS');
    const models = fromEnv
      ?.split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    return models && models.length > 0 ? models : this.defaultOpenRouterModels;
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

    const extension = extname(originalName).toLowerCase();
    if (extension !== '.pdf' && extension !== '.docx') {
      throw new BadRequestException(
        'Format non supporté. Importe un fichier PDF ou DOCX.',
      );
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

    try {
      if (extension === '.pdf') {
        const pdf = await pdfParse(fileBuffer);
        extractedText = pdf.text ?? '';
      } else {
        const resultDocx = await mammoth.extractRawText({ buffer: fileBuffer });
        extractedText = resultDocx.value ?? '';
      }
    } catch (error) {
      console.error("[Project AI] Erreur d'extraction du texte:", error);
      throw new BadRequestException('Erreur lors de la lecture du document.');
    }

    extractedText = extractedText
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (!extractedText) {
      throw new BadRequestException(
        'Aucun texte extractible. Un OCR peut être nécessaire.',
      );
    }

    console.log(
      '[Project AI] Extrait du texte :',
      JSON.stringify(extractedText.slice(0, 200)),
    );

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
          originalName,
          mimeType,
          fileSize: fileBuffer.length,
          storagePath: blobUrl,
          extractedText,
        },
        update: {
          fileName: generatedFileName,
          originalName,
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
          (err) =>
            console.warn(
              "[Project AI] Impossible de supprimer l'ancien blob:",
              err.message,
            ),
        );
      }
    }

    return {
      message: 'Cahier des charges importé et texte extrait.',
      specification,
      extractedCharacters: extractedText.length,
    };
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
        clientName: (project.client as { name?: string })?.name ?? '',
        extractedText: specification.extractedText,
        // 👇 Nouvelles données du projet
        fixedDurationDays: project.durationDays,
        consommablesResponsible: project.consommablesResponsible,
      });

      this.validatePricingCoherence(analysisResult);

      const validPositions = new Set<string>(Object.values(EmployeePosition));

      const workforce = analysisResult.workforce
        .filter((item) => validPositions.has(item.position))
        .map((item) => ({
          position: item.position as EmployeePosition,
          quantity: item.quantity,
          reason: item.reason,
        }))
        .filter((item) => item.quantity > 0);

      if (workforce.length < analysisResult.workforce.length) {
        console.warn(
          '[Project AI] Postes ignorés (hors enum) :',
          analysisResult.workforce
            .filter((w) => !validPositions.has(w.position))
            .map((w) => w.position),
        );
      }

      const hypotheses = [...analysisResult.hypotheses];
      if (analysisResult.accommodation === 'non_precise') {
        hypotheses.push(
          "Logement non précisé dans le document : chiffré à la charge de l'entreprise.",
        );
      }
      if (analysisResult.transport === 'non_precise') {
        hypotheses.push(
          "Transport et déplacements non précisés dans le document : chiffrés à la charge de l'entreprise.",
        );
      }

      const r = this.rates;
      const hoursFactor = this.hoursCostFactor(
        analysisResult.workingHoursPerDay,
        r.heuresSup,
      );
      const riskRate = r.aleas[analysisResult.riskLevel];

      const pricedLots = analysisResult.lots.map((lot) =>
        this.priceLot(lot, {
          hoursFactor,
          riskRate,
          accommodation: analysisResult.accommodation,
          transport: analysisResult.transport,
          // 👇 Nouvelles données pour le chiffrage
          employeeDailyRate: project.employeeDailyRate,
          consommablesResponsible: project.consommablesResponsible,
          manutentionPercentage: project.manutentionPercentage,
        }),
      );

      const totalHT = round2(
        pricedLots.reduce((sum, lot) => sum + lot.total, 0),
      );
      const totalTVA = round2(totalHT * this.TVA_RATE);
      const totalTTC = round2(totalHT + totalTVA);

      const totalLabour = pricedLots.reduce(
        (sum, lot) => sum + lot.components.labour,
        0,
      );
      const labourRatio = totalHT > 0 ? totalLabour / totalHT : 0;
      if (labourRatio < 0.35 || labourRatio > 0.85) {
        const warning = `Ratio main-d'œuvre anormal : ${Math.round(
          labourRatio * 100,
        )} % (attendu 35–85 %). Vérifier manuellement les effectifs et durées.`;
        console.warn(`[Project AI] ${warning}`);
        hypotheses.push(warning);
      }

      const phaseCosts = allocateByWeights(
        totalHT,
        analysisResult.workPhases.map(
          (phase) => phase.durationDays * Math.max(1, totalStaff(phase.staff)),
        ),
      );

      const workPhases = analysisResult.workPhases.map((phase, index) => ({
        name: phase.name,
        description: phase.description,
        order: phase.order ?? index + 1,
        durationDays: phase.durationDays,
        estimatedCost: phaseCosts[index],
      }));

      console.log(
        `[Project AI] ${pricedLots.length} lot(s) chiffré(s), risque ${analysisResult.riskLevel} (${Math.round(riskRate * 100)} %), total HT = ${totalHT} TND, ratio MO = ${Math.round(labourRatio * 100)} %.`,
      );

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
              riskRate,
              mainOeuvreRate: project.employeeDailyRate || r.mainOeuvre,
              labourRatio,
              lots: pricedLots.map(
                (lot): StoredLot => ({
                  name: lot.name,
                  description: lot.description,
                  quoteDescription: lot.quoteDescription,
                  total: lot.total,
                  components: lot.components,
                  durationDays: lot.durationDays,
                  headcount: lot.headcount,
                  staff: lot.staff,
                  quantities: lot.quantities,
                  handling: lot.handling,
                }),
              ),
            },
          }),
          estimation: {
            create: {
              estimatedPrice: totalHT,
              minPrice: round2(totalHT * this.FOURCHETTE_BASSE),
              maxPrice: round2(totalHT * this.FOURCHETTE_HAUTE),
              durationDays: analysisResult.durationDays,
              minDurationDays: analysisResult.minDurationDays,
              maxDurationDays: analysisResult.maxDurationDays,
              confidence: analysisResult.confidence,
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
            },
          },
        },
        include: {
          estimation: true,
          workPhases: { orderBy: { order: 'asc' } },
          workforce: true,
          priceSchedule: true,
        },
      });

      let createdQuote: Awaited<ReturnType<QuotesService['create']>> | null =
        null;

      try {
        const quoteLines = this.buildQuoteLines(pricedLots, totalHT);

        if (quoteLines.length > 0) {
          const validUntil = new Date();
          validUntil.setDate(validUntil.getDate() + 30);

          createdQuote = await this.quotesService.create({
            clientId: project.clientId,
            projectId: project.id,
            validUntil: validUntil.toISOString(),
            notes: `Devis généré automatiquement par IA pour le projet "${project.name}". À valider avant envoi au client.`,
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
        avertissementPrix: `Estimation indicative, calculée lot par lot : main-d'œuvre ${project.employeeDailyRate || r.mainOeuvre} TND/jour pour TOUS les employés du chantier, consommables ${project.consommablesResponsible === 'client' ? '0 (fournis par le client)' : `${Math.round(r.consommables * 100)} %`}, logement ${r.logementNuit} TND/personne/nuit, logistique ${r.logistique} TND/personne/jour, manutention ${project.manutentionPercentage ? `${Math.round(project.manutentionPercentage * 100)} %` : 'au tarif journalier'}, aléas ${Math.round(riskRate * 100)} % (niveau de risque ${analysisResult.riskLevel}) et marge ${Math.round(r.marge * 100)} %. À valider avant la création du devis.`,
        hypotheses,
        informationsManquantes: analysisResult.missingInformation,
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

  private validatePricingCoherence(result: AIResult): void {
    const duration = Math.max(1, result.durationDays);
    const coherenceWarnings: string[] = [];

    for (const lot of result.lots) {
      const headcount = totalStaff(lot.staff);
      const personDays = headcount * lot.durationDays;

      if (headcount === 0) {
        coherenceWarnings.push(
          `Lot "${lot.name}" sans effectif → repli interne appliqué.`,
        );
      }

      if (headcount > 200) {
        throw new BadRequestException(
          `Lot "${lot.name}" : effectif irréaliste (${headcount}). Vérifie le cahier des charges.`,
        );
      }

      if (lot.durationDays > duration) {
        coherenceWarnings.push(
          `Lot "${lot.name}" (${lot.durationDays} j) plus long que le projet (${duration} j).`,
        );
      }

      if (personDays > 20_000) {
        throw new BadRequestException(
          `Lot "${lot.name}" : ${personDays} jours-homme irréalistes. Vérifie les effectifs et durées.`,
        );
      }
    }

    const peak = result.workforce.reduce((s, w) => s + w.quantity, 0);
    const maxLotHeadcount = Math.max(
      0,
      ...result.lots.map((l) => totalStaff(l.staff)),
    );

    if (peak > 0 && maxLotHeadcount > 0 && peak < maxLotHeadcount * 0.5) {
      coherenceWarnings.push(
        `Effectif de pointe (${peak}) très inférieur au plus gros lot (${maxLotHeadcount}).`,
      );
    }

    if (coherenceWarnings.length > 0) {
      console.warn(
        '[Project AI] Avertissements de cohérence :',
        coherenceWarnings,
      );
      result.hypotheses.push(...coherenceWarnings);
    }
  }

  private hoursCostFactor(
    hoursPerDay: number | null,
    overtimeMultiplier: number,
  ): number {
    const hours = Math.min(Math.max(hoursPerDay ?? 8, 1), 16);
    if (hours <= 8) return 1;
    return (8 + (hours - 8) * overtimeMultiplier) / 8;
  }

  private handlingDailyRate(name: string): number {
    const m = this.rates.manutention;
    const text = name.toLowerCase();

    if (/grue|crane|manitou|t[ée]lescop/.test(text)) return m.grue;
    if (/chariot|[ée]l[ée]vateur|forklift/.test(text)) return m.chariot;
    if (/nacelle|plateforme|aerial/.test(text)) return m.nacelle;
    if (/[ée]chafaud|scaffold/.test(text)) return m.echafaudage;
    if (/palan|pont roulant|treuil|hoist|tirfor/.test(text)) return m.palan;
    return m.defaut;
  }

  private priceLot(
    lot: AILot,
    ctx: {
      hoursFactor: number;
      riskRate: number;
      accommodation: Arrangement;
      transport: Arrangement;
      employeeDailyRate: number | null;
      consommablesResponsible: string | null;
      manutentionPercentage: number | null;
    },
  ): PricedLot {
    const r = this.rates;

    let headcount = totalStaff(lot.staff);
    let finalStaff = lot.staff;

    if (headcount === 0) {
      headcount = this.DEFAULT_LOT_TECHNICIANS + this.DEFAULT_LOT_LEADERS;
      finalStaff = [
        { position: 'TECHNICIAN', quantity: this.DEFAULT_LOT_TECHNICIANS },
        { position: 'TEAM_LEADER', quantity: this.DEFAULT_LOT_LEADERS },
      ];
    }

    const days = lot.durationDays;

    // Main-d'œuvre : utilise le tarif spécifique du projet si fourni
    const dailyRate = ctx.employeeDailyRate || r.mainOeuvre;
    const labour = headcount * days * dailyRate * ctx.hoursFactor;

    // Consommables : 0 si le client les fournit
    const consumables =
      ctx.consommablesResponsible === 'client' ? 0 : labour * r.consommables;

    const accommodationQty = ctx.accommodation === 'client' ? 0 : days * headcount;
    const logisticsQty = ctx.transport === 'client' ? 0 : days * headcount;
    const accommodation = accommodationQty * r.logementNuit;
    const logistics = logisticsQty * r.logistique;

    // Manutention : forfaitaire en % si spécifié, sinon via l'IA
    let handling = 0;
    let handlingLines: HandlingLine[] = [];

    if (ctx.manutentionPercentage !== null && ctx.manutentionPercentage > 0) {
      handling = labour * ctx.manutentionPercentage;
      handlingLines = [
        {
          name: 'Forfait manutention',
          days: days,
          base: round2(handling),
        },
      ];
    } else {
      handlingLines = lot.handlingEquipment.map((equipment) => {
        const equipmentDays = Math.min(equipment.days, days);
        return {
          name: equipment.name,
          days: equipmentDays,
          base: round2(equipmentDays * this.handlingDailyRate(equipment.name)),
        };
      });
      handling = handlingLines.reduce((sum, line) => sum + line.base, 0);
    }

    const factor = (1 + ctx.riskRate) * (1 + r.marge) * r.calage;
    const subtotal = labour + consumables + accommodation + logistics + handling;
    const total = round2(subtotal * factor);

    const components: CostComponents = {
      labour: round2(labour * factor),
      consumables: round2(consumables * factor),
      accommodation: round2(accommodation * factor),
      logistics: round2(logistics * factor),
      handling: round2(handling * factor),
    };

    const diff = round2(
      total -
        (components.labour +
          components.consumables +
          components.accommodation +
          components.logistics +
          components.handling),
    );
    components.labour = round2(components.labour + diff);

    return {
      ...lot,
      staff: finalStaff,
      headcount,
      quoteDescription: (lot.description
        ? `${lot.name} – ${lot.description}`
        : lot.name
      )
        .slice(0, 250)
        .trim(),
      total,
      components,
      quantities: {
        labourPersonDays: days * headcount,
        accommodationPersonNights: accommodationQty,
        logisticsPersonDays: logisticsQty,
      },
      handling: handlingLines,
    };
  }

  private buildQuoteLines(lots: PricedLot[], totalHT: number) {
    if (lots.length === 0) return [];

    const taxRate = Math.round(this.TVA_RATE * 100);

    const entries = lots.map((lot) => ({
      description: lot.quoteDescription,
      amount: lot.total,
    }));

    const diff = round2(
      totalHT - entries.reduce((sum, entry) => sum + entry.amount, 0),
    );
    entries[entries.length - 1].amount = round2(
      entries[entries.length - 1].amount + diff,
    );

    return entries.map((entry) => ({
      description: entry.description,
      quantity: 1,
      unitPrice: entry.amount,
      taxRate,
    }));
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

  async generatePriceSchedulePdf(
    analysisId: string,
    projectId: string,
  ): Promise<Buffer> {
    const analysis = await this.prisma.projectAIAnalysis.findUnique({
      where: { id: analysisId },
      include: {
        specification: {
          include: {
            project: {
              include: { client: true },
            },
          },
        },
        workPhases: { orderBy: { order: 'asc' } },
        workforce: true,
        estimation: true,
      },
    });

    if (!analysis || (projectId && analysis.projectId !== projectId)) {
      throw new NotFoundException('Analyse introuvable.');
    }

    const project = analysis.specification.project;

    const quote = await this.prisma.quote.findFirst({
      where: { projectId: analysis.projectId },
      include: { lines: true },
    });

    if (!quote) {
      throw new NotFoundException('Devis introuvable pour ce projet.');
    }

    const quoteLines = quote.lines as any[];

    const { analysis: storedAnalysis, lots: storedLots } =
      this.readStoredAnalysis((analysis as any).rawResponse);

    const storedByDescription = new Map<string, StoredLot>();
    for (const lot of storedLots) {
      storedByDescription.set(normalizeKey(lot.quoteDescription), lot);
    }

    const formatMoney = (value: unknown): string =>
      Number(value ?? 0).toLocaleString('fr-TN', {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      });
    const formatQty = (value: number): string =>
      Number.isInteger(value) ? String(value) : String(round2(value));

    let totalHT = 0;
    let totalTva = 0;

    const sections = quoteLines.map((quoteLine, index) => {
      const lineTotalHT = round2(
        Number(quoteLine.unitPrice) * Number(quoteLine.quantity),
      );
      totalHT += lineTotalHT;
      totalTva += lineTotalHT * ((Number(quoteLine.taxRate) || 0) / 100);

      const stored = storedByDescription.get(
        normalizeKey(String(quoteLine.description ?? '')),
      );
      const detailLines = this.buildDetailLines(stored);

      const amounts = allocateByWeights(
        lineTotalHT,
        detailLines.map((line) => line.weight),
      );

      return {
        title: `${index + 1}. ${quoteLine.description}`,
        items: detailLines.map((line, i) => ({
          designation: line.designation,
          unit: line.unit,
          quantity: formatQty(line.quantity),
          unitPrice: formatMoney(
            line.quantity > 0 ? amounts[i] / line.quantity : amounts[i],
          ),
          amount: formatMoney(amounts[i]),
        })),
        subtotal: formatMoney(lineTotalHT),
      };
    });

    totalHT = round2(totalHT);
    totalTva = round2(totalTva);
    const totalTtc = round2(totalHT + totalTva);

    const workforceRows = (analysis.workforce as any[]).map((w) => ({
      position: humanizePosition(String(w.position)),
      quantity: Number(w.quantity) || 0,
    }));
    const workforceTotal = workforceRows.reduce((s, w) => s + w.quantity, 0);

    const lotTeams = storedLots
      .filter(
        (lot) =>
          typeof lot.headcount === 'number' &&
          typeof lot.durationDays === 'number',
      )
      .map((lot) => {
        const persons = lot.headcount as number;
        const days = lot.durationDays as number;
        const composition = Array.isArray(lot.staff)
          ? lot.staff
              .map(
                (s) => `${humanizePosition(s.position)} ×${toInt(s.quantity, 0)}`,
              )
              .join(', ')
          : '—';

        return {
          name: lot.name,
          composition,
          persons,
          days,
          personDays: persons * days,
          handling:
            (lot.handling ?? [])
              .map((h) => `${h.name} (${h.days} j)`)
              .join(', ') || '—',
        };
      });

    const lotTotals = {
      persons: lotTeams.reduce((s, l) => s + l.persons, 0),
      personDays: lotTeams.reduce((s, l) => s + l.personDays, 0),
    };

    const preparations = (
      Array.isArray(storedAnalysis?.preparations)
        ? storedAnalysis.preparations
        : []
    )
      .map((p: any) => ({
        name: toStr(p?.name) ?? '',
        description: toStr(p?.description) ?? '',
      }))
      .filter((p: { name: string }) => p.name)
      .map((p: { name: string; description: string }, i: number) => ({
        index: i + 1,
        ...p,
      }));

    const aiPhases: any[] = Array.isArray(storedAnalysis?.workPhases)
      ? storedAnalysis.workPhases
      : [];
    const phaseSource: any[] =
      aiPhases.length > 0 ? aiPhases : (analysis.workPhases as any[]);

    const phases = phaseSource
      .map((p: any, i: number) => {
        const staffArr: AIPhaseStaff[] = Array.isArray(p.staff) ? p.staff : [];
        const staffCount = totalStaff(staffArr);
        const composition = staffArr
          .map(
            (s) => `${humanizePosition(String(s.position))} ×${toInt(s.quantity, 0)}`,
          )
          .join(', ');

        return {
          order: toInt(p.order, i + 1),
          name: String(p.name ?? ''),
          description: toStr(p.description) ?? '',
          durationDays: toInt(p.durationDays, 1),
          staff: staffCount > 0 ? `${staffCount} (${composition})` : '—',
        };
      })
      .sort((a, b) => a.order - b.order);

    const durationDays =
      (analysis.estimation as any)?.durationDays ??
      storedAnalysis?.durationDays ??
      null;
    const hoursPerDay = storedAnalysis?.workingHoursPerDay ?? null;
    const peakHeadcount =
      workforceTotal > 0 ? workforceTotal : lotTotals.persons || null;

    const kpis = [
      {
        label: 'Durée du chantier',
        value: durationDays ? `${durationDays} j` : '—',
      },
      {
        label: 'Effectif de pointe',
        value: peakHeadcount ? String(peakHeadcount) : '—',
      },
      {
        label: 'Jours-homme',
        value: lotTotals.personDays ? String(lotTotals.personDays) : '—',
      },
      {
        label: hoursPerDay ? 'Heures par jour' : 'Lots de travaux',
        value: hoursPerDay ? `${hoursPerDay} h` : String(sections.length),
      },
    ];

    const summary = toStr(analysis.summary) ?? '';
    let counter = 0;
    const next = () => ++counter;
    const numbers = {
      presentation: summary ? next() : null,
      workforce: workforceRows.length > 0 || lotTeams.length > 0 ? next() : null,
      preparation: preparations.length > 0 ? next() : null,
      planning: phases.length > 0 ? next() : null,
      bordereau: 0,
    };
    numbers.bordereau = next();

    const template = await this.prisma.documentTemplate.findFirst({
      where: { type: 'QUOTE', isDefault: true, isActive: true },
      include: { style: true },
    });

    const templateData = {
      project: {
        name: project.name,
        daNumber: project.daNumber ?? null,
        clientName: (project.client as { name?: string })?.name ?? '—',
        location: project.location || '—',
      },
      quoteNumber: quote.number,
      generatedAt: new Date().toLocaleDateString('fr-FR'),
      n: numbers,
      report: {
        summary,
        kpis,
        workforce: workforceRows,
        workforceTotal,
        lotTeams,
        lotTotals,
        preparations,
        phases,
      },
      priceSchedule: {
        sections,
        totalGeneral: formatMoney(totalHT),
        totalTva: formatMoney(totalTva),
        totalTtc: formatMoney(totalTtc),
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

    const html = Handlebars.compile(REPORT_TEMPLATE)(templateData);

    const puppeteer = (await import('puppeteer-core')).default;
    const chromium = (await import('@sparticuz/chromium')).default;

    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: 45_000 });
      await page.evaluate(() => (document as any).fonts?.ready);

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

  private readStoredAnalysis(rawValue: unknown): {
    analysis: any | null;
    lots: StoredLot[];
  } {
    try {
      const parsed: any =
        typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
      if (!parsed || typeof parsed !== 'object') {
        return { analysis: null, lots: [] };
      }

      const analysis = parsed.analysis ?? (parsed.workPhases ? parsed : null);
      const lots: StoredLot[] = Array.isArray(parsed.pricing?.lots)
        ? parsed.pricing.lots.filter(
            (l: any) => l?.quoteDescription && l?.components,
          )
        : [];

      return { analysis, lots };
    } catch (error) {
      console.warn(
        '[Project AI] Détail du chiffrage illisible, répartition par défaut utilisée.',
        error,
      );
      return { analysis: null, lots: [] };
    }
  }

  private buildDetailLines(stored: StoredLot | undefined): DetailLine[] {
    const fallback = (): DetailLine[] =>
      DEFAULT_PRICE_ITEMS.map((item) => ({
        designation: item.description,
        unit: 'forfait',
        quantity: 1,
        weight: item.weight,
      }));

    if (!stored) return fallback();

    const c = stored.components;
    const q = stored.quantities;
    const lines: DetailLine[] = [];

    lines.push({
      designation: COMPONENT_LABELS.labour,
      unit: q ? 'jour-homme' : 'forfait',
      quantity: q ? q.labourPersonDays : 1,
      weight: Number(c.labour) || 0,
    });

    lines.push({
      designation: COMPONENT_LABELS.consumables,
      unit: 'forfait',
      quantity: 1,
      weight: Number(c.consumables) || 0,
    });

    lines.push({
      designation: COMPONENT_LABELS.accommodation,
      unit: q ? 'nuitée' : 'forfait',
      quantity: q ? q.accommodationPersonNights : 1,
      weight: Number(c.accommodation) || 0,
    });

    lines.push({
      designation: COMPONENT_LABELS.logistics,
      unit: q ? 'jour-homme' : 'forfait',
      quantity: q ? q.logisticsPersonDays : 1,
      weight: Number(c.logistics) || 0,
    });

    const handlingTotal = Number(c.handling) || 0;
    const handlingLines = stored.handling ?? [];
    const baseSum = handlingLines.reduce((s, h) => s + (Number(h.base) || 0), 0);

    if (handlingTotal > 0 && handlingLines.length > 0 && baseSum > 0) {
      for (const h of handlingLines) {
        lines.push({
          designation: `Manutention et levage : ${h.name}`,
          unit: 'jour',
          quantity: h.days,
          weight: (handlingTotal * (Number(h.base) || 0)) / baseSum,
        });
      }
    } else if (handlingTotal > 0) {
      lines.push({
        designation: COMPONENT_LABELS.handling,
        unit: 'forfait',
        quantity: 1,
        weight: handlingTotal,
      });
    }

    const nonZero = lines.filter((line) => line.weight > 0);
    return nonZero.length > 0 ? nonZero : fallback();
  }

  private async callOpenRouterForAnalysis(input: {
    projectName: string;
    projectDescription: string;
    location: string;
    clientName: string;
    extractedText: string;
    fixedDurationDays: number | null;
    consommablesResponsible: string | null;
  }): Promise<AIResult> {
    const availablePositions = Object.values(EmployeePosition).join(', ');
    const r = this.rates;

    const systemPrompt = `
Tu es un ingénieur senior en maintenance industrielle, montage mécanique lourd,
chaudronnerie, levage et gestion de projets industriels en Tunisie. Tu prépares
des offres technico-financières pour des clients industriels exigeants.

TON OBJECTIF : produire une estimation technique RÉALISTE, JUSTIFIÉE et
ÉCONOMIQUEMENT COHÉRENTE. Le prix doit être ni gonflé ni sous-estimé.

LANGUE : document en FR/AR/EN possible. Tu réponds toujours en français.
FORMAT  : uniquement un objet JSON valide, sans Markdown ni texte autour.
INTERDIT: ne retourne JAMAIS de prix, montant ou tarif en dinars.

═══════════════════════════════════════════════════════════════
RÈGLE FONDAMENTALE SUR LA MAIN-D'ŒUVRE
═══════════════════════════════════════════════════════════════
Le backend calcule : coût MO = (Σ staff.quantity du lot) × durationDays × ${r.mainOeuvre} TND.

CHAQUE employé listé est compté, quel que soit son poste. Donc :
- Liste TOUS les postes réellement nécessaires (soudeurs, mécaniciens,
  électriciens, chaudronniers, tuyauteurs, chefs d'équipe, ingénieurs,
  HSE, magasiniers, grutiers, élingueurs, manutentionnaires…).
- N'OMETS aucun poste indispensable (HSE, grutier, élingueur sont
  souvent oubliés → sous-estimation).
- NE GONFLE PAS : pas de doublons, pas de postes « au cas où »,
  pas d'équipe de nuit si le chantier est diurne.
- Chaque personne listée doit avoir une justification technique
  implicite dans la description du lot.

═══════════════════════════════════════════════════════════════
MÉTHODE DE DIMENSIONNEMENT (OBLIGATOIRE, ÉTAPE PAR ÉTAPE)
═══════════════════════════════════════════════════════════════

ÉTAPE A — Inventaire physique
Liste les équipements/ensembles à traiter avec : poids (t), dimensions,
nombre de composants, niveau d'accessibilité (sol / hauteur / confiné).

ÉTAPE B — Productivité de référence (utilise ces ordres de grandeur,
ajuste selon complexité, justifie tout écart > 30 %) :

| Opération                        | Productivité indicative      |
|----------------------------------|------------------------------|
| Démontage boulonné courant       | 0,5 – 1,5 t / homme-jour     |
| Démontage grippé/corrodé         | 0,2 – 0,5 t / homme-jour     |
| Montage mécanique précis         | 0,3 – 0,8 t / homme-jour     |
| Soudure chaudronnerie (épaisse)  | 3 – 8 m linéaire / soudeur-j |
| Découpe / préparation surfaces   | 5 – 15 m² / homme-jour       |
| Alignement / réglage             | 1 – 3 équipements / équipe-j |
| Élingage + levage grue           | 4 – 10 levages / grutier-j   |

ÉTAPE C — Calcul des jours-homme par lot
Pour chaque lot :
  JH_lot = Σ(staff.quantity) × durationDays
Vérifie que JH_lot ÷ (tonnage ou métrage du lot) reste DANS la fourchette
de productivité ci-dessus. Si hors fourchette, corrige l'effectif ou la durée
AVANT de répondre.

ÉTAPE D — Contrôle de cohérence croisée (à faire avant de répondre)
1. JH total du projet = Σ JH_lot. Doit être cohérent avec le tonnage total.
2. Effectif de pointe (workforce) ≤ effectif maximal simultané des lots.
3. Durée du projet ≥ durée du lot le plus long (sauf parallélisme justifié).
4. Ratio main-d'œuvre / total estimé : le backend applique ${r.mainOeuvre} TND/j
   + ${Math.round(r.consommables * 100)} % consommables + logement + logistique
   + manutention + aléas + marge. Si le résultat te semble aberrant,
   ajuste les effectifs/durées, PAS les tarifs.

═══════════════════════════════════════════════════════════════
GARDE-FOUS ANTI-GONFLAGE (vérifie explicitement)
═══════════════════════════════════════════════════════════════
✗ Pas d'équipe de nuit si le CDC ne l'exige pas.
✗ Pas de chef d'équipe par lot si un seul chef couvre plusieurs lots
  en séquence (le préciser dans la description).
✗ Pas de grue sur toute la durée si elle n'est utilisée que quelques jours
  (mettre days = jours réels d'utilisation).
✗ Pas de HSE à temps plein si le chantier est court (< 10 j) : prévoir
  un HSE mutualisé et le mentionner dans hypotheses.
✗ Pas de double comptage d'un équipement partagé entre lots.
✗ Pas de marge de sécurité cachée dans les effectifs : la sécurité est
  déjà couverte par les aléas (${Math.round(r.aleas.faible * 100)}–${Math.round(r.aleas.eleve * 100)} %).

═══════════════════════════════════════════════════════════════
GARDE-FOUS ANTI-SOUS-ESTIMATION (vérifie explicitement)
═══════════════════════════════════════════════════════════════
✓ HSE présent dès qu'il y a levage, hauteur, confinement ou coactivité.
✓ Grutier + élingueur dès qu'une grue est mobilisée.
✓ Magasinier/réceptionnaire si fournitures ou pièces client à gérer.
✓ Chef d'équipe pour chaque équipe autonome (> 3 personnes).
✓ Temps de préparation, consignation, essais et remise en service comptés.
✓ Moyens de levage adaptés au poids ET au rayon (pas seulement au poids).
✓ Si une donnée manque (poids, accès, délai), NE PAS deviner : l'ajouter
  dans missingInformation et poser une hypothèse explicite dans hypotheses.

═══════════════════════════════════════════════════════════════
DÉCOMPOSITION EN LOTS ET PHASES
═══════════════════════════════════════════════════════════════
- Un LOT = ensemble technique identifiable et chiffrable (ligne de devis).
  → name, description, durationDays, staff[], handlingEquipment[].
- Une PHASE = étape chronologique du planning.
  → name, description, order, durationDays, staff[].
- Les lots servent au CHIFFRAGE, les phases au PLANNING.
- Ne jamais additionner JH des lots et JH des phases (double comptage).
- Regroupe les opérations réellement liées ; ne crée pas de lots artificiels.

═══════════════════════════════════════════════════════════════
MOYENS DE LEVAGE / MANUTENTION
═══════════════════════════════════════════════════════════════
- name = désignation précise (ex. « Grue mobile 50 t », « Chariot 3 t »).
- days = jours RÉELS d'utilisation (pas la durée du lot).
- Ne chiffre pas un moyen fourni par le client → hypotheses.
- Évite de facturer deux fois un moyen partagé.

═══════════════════════════════════════════════════════════════
HÉBERGEMENT / TRANSPORT
═══════════════════════════════════════════════════════════════
accommodation : "client" | "entreprise" | "non_precise"
transport     : "client" | "entreprise" | "non_precise"
Ne présume pas que le client fournit ; si non précisé → "non_precise".

═══════════════════════════════════════════════════════════════
EFFECTIF DE POINTE (workforce)
═══════════════════════════════════════════════════════════════
Positions autorisées (valeurs EXACTES de l'enum) :
${availablePositions}

- quantity = effectif de POINTE (simultané), pas le cumul.
- Pas de doublons.
- Distingue personnel des lots et personnel de support.

═══════════════════════════════════════════════════════════════
RISQUE
═══════════════════════════════════════════════════════════════
riskLevel : faible | moyen | eleve
Évalue : poids, levage, hauteur, confinement, tolérances, coactivité,
délais, pénalités, incertitudes techniques.
riskReasons : 1 à 5 justifications précises.
Ne choisis pas « eleve » par défaut.

═══════════════════════════════════════════════════════════════
PRÉPARATION
═══════════════════════════════════════════════════════════════
4 à 10 actions pertinentes (visite, HSE, plan de levage, consignation,
balisage, mobilisation, outillage, permis…).

═══════════════════════════════════════════════════════════════
TRAÇABILITÉ
═══════════════════════════════════════════════════════════════
evidence : 1 à 5 extraits EXACTS du CDC justifiant les données clés.
hypotheses : toutes les hypothèses (distinguer confirmé / estimé).
missingInformation : données manquantes empêchant un chiffrage fiable.

═══════════════════════════════════════════════════════════════
CONTRÔLE FINAL OBLIGATOIRE (auto-vérification chiffrée)
═══════════════════════════════════════════════════════════════
Avant de produire le JSON, calcule et vérifie :
1. Σ staff.quantity par lot → reporté dans ta tête.
2. JH_lot = Σ staff.quantity × durationDays.
3. JH_total = Σ JH_lot.
4. JH_total ÷ tonnage total → doit rester dans les fourchettes de productivité.
5. Effectif de pointe ≤ max des effectifs simultanés.
6. Durée projet ≥ max(durationDays des lots) sauf parallélisme justifié.
7. Chaque lot a au moins un chef d'équipe si > 3 personnes.
8. HSE et grutier/élingueur présents si levage/hauteur/coactivité.
9. Aucun moyen de levage facturé plus de jours que nécessaire.
10. Toute donnée manquante est dans missingInformation.

Si une vérification échoue, CORRIGE les effectifs/durées AVANT de répondre.
Tu réponds exclusivement au format JSON demandé.
`;

    const { text: specText, truncated } = this.prepareSpecText(
      input.extractedText,
    );

    // Ajout des contraintes spécifiques au projet
    let projectConstraints = '';
    if (input.fixedDurationDays) {
      projectConstraints += `\n- Durée imposée : ${input.fixedDurationDays} jours (RESPECTE STRICTEMENT cette durée).`;
    }
    if (input.consommablesResponsible === 'client') {
      projectConstraints += `\n- Les consommables sont FOURNIS PAR LE CLIENT (ne les chiffre pas).`;
    }

    const prompt = `
ANALYSE TECHNIQUE ET QUANTITATIVE DU PROJET

INFORMATIONS PROJET
Nom          : ${input.projectName}
Description  : ${input.projectDescription}
Localisation : ${input.location}
Client       : ${input.clientName}
${projectConstraints}

OBJECTIF
Analyse complète destinée à un devis professionnel de maintenance industrielle.
Le prix final doit être JUSTE : ni gonflé, ni sous-estimé.

RAPPEL MAIN-D'ŒUVRE
coût MO = (Σ staff.quantity) × durationDays × ${r.mainOeuvre} TND.
Chaque employé listé est compté → liste TOUS les postes nécessaires,
sans omission et sans gonflage.

MÉTHODE IMPOSÉE
1. Inventaire physique (poids, dimensions, accès) de chaque ensemble.
2. Application des productivités de référence (voir prompt système).
3. Calcul des JH par lot, puis contrôle croisé JH/tonnage.
4. Vérification des garde-fous anti-gonflage ET anti-sous-estimation.
5. Remplissage des hypothèses et informations manquantes.

AVANT DE RÉPONDRE, EFFECTUE LE CONTRÔLE CHIFFRÉ SUIVANT (dans ta tête) :
- JH_lot = Σ staff.quantity × durationDays (pour chaque lot)
- JH_total = Σ JH_lot
- JH_total ÷ tonnage ≈ dans les fourchettes de productivité
- Effectif de pointe ≤ effectif simultané maximal
- Durée projet ≥ durée du lot le plus long (sauf parallélisme justifié)
- HSE / grutier / élingueur présents si levage, hauteur ou coactivité
- Aucun moyen de levage facturé plus de jours que nécessaire

Si un contrôle échoue → corrige effectifs/durées AVANT de répondre.

FORMAT JSON OBLIGATOIRE

{
  "resumeProjet": "<résumé technique 3-6 phrases>",
  "durationDays": <entier>,
  "minDurationDays": <entier|null>,
  "maxDurationDays": <entier|null>,
  "workingHoursPerDay": <nombre|null>,
  "confidence": <0-100>,
  "currency": "TND",
  "accommodation": "<client|entreprise|non_precise>",
  "transport": "<client|entreprise|non_precise>",
  "riskLevel": "<faible|moyen|eleve>",
  "riskReasons": ["<justification>"],
  "evidence": ["<extrait exact du CDC>"],
  "preparations": [{ "name": "<action>", "description": "<détail>" }],
  "lots": [{
    "name": "<nom du lot>",
    "description": "<description technique>",
    "durationDays": <entier>,
    "staff": [{ "position": "<valeur exacte enum>", "quantity": <entier> }],
    "handlingEquipment": [{ "name": "<moyen>", "days": <entier> }]
  }],
  "workPhases": [{
    "name": "<phase>",
    "description": "<contenu>",
    "order": <entier>,
    "durationDays": <entier>,
    "staff": [{ "position": "<valeur exacte enum>", "quantity": <entier> }]
  }],
  "workforce": [{ "position": "<valeur exacte enum>", "quantity": <entier>, "reason": "<justification>" }],
  "hypotheses": ["<hypothèse>"],
  "missingInformation": ["<info manquante>"]
}

RAPPELS FINAUX
- staff contient TOUS les employés du lot (pas seulement techniciens + chefs).
- Le backend multiplie Σ staff.quantity × durationDays × ${r.mainOeuvre} TND.
- Lots = chiffrage / Phases = planning / ne pas additionner les JH.
- Donnée inconnue → missingInformation, pas d'invention.

<cahier_des_charges>
${specText}
</cahier_des_charges>
`;

    return this.callOpenRouterApi<AIResult>({
      prompt,
      systemPrompt,
      maxTokens: 16000,
      validate: (parsed) => {
        const result = this.normalizeAnalysisResult(parsed);

        if (result.lots.length === 0) {
          throw new BadRequestException(
            'La réponse IA ne contient aucun lot de travaux.',
          );
        }
        if (truncated) {
          result.missingInformation.push(
            `Le document dépasse ${r.maxSpecChars} caractères : sa partie centrale n'a pas été analysée. Le prix peut être sous-estimé.`,
          );
        }
        return result;
      },
    });
  }

  private prepareSpecText(text: string): { text: string; truncated: boolean } {
    const max = this.rates.maxSpecChars;
    if (text.length <= max) return { text, truncated: false };

    console.warn(
      `[Project AI] Document tronqué : ${text.length} caractères pour une limite de ${max}.`,
    );

    const tailSize = Math.floor(max * 0.4);
    const headSize = max - tailSize;

    return {
      text: `${text.slice(0, headSize)}

[... partie centrale du document omise pour raisons de taille ...]

${text.slice(-tailSize)}`,
      truncated: true,
    };
  }

  private async callOpenRouterApi<T = any>(params: {
    prompt: string;
    systemPrompt: string;
    maxTokens: number;
    validate?: (parsed: any) => T;
  }): Promise<T> {
    const { prompt, systemPrompt, maxTokens, validate } = params;
    const apiKey = this.getOpenRouterApiKey();
    const url = `${this.openRouterBaseUrl}/chat/completions`;
    const referer =
      this.config.get<string>('APP_URL') ?? 'http://localhost:3000';

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
            signal: AbortSignal.timeout(900_000),
            body: JSON.stringify({
              model,
              temperature: 0,
              max_tokens: maxTokens,
              ...(useJsonMode
                ? { response_format: { type: 'json_object' } }
                : {}),
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt },
              ],
            }),
          });

          console.log(
            `[OpenRouter] ${model} (essai ${attempt}) - statut HTTP :`,
            response.status,
          );

          if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            lastError = `${model}: HTTP ${response.status} ${errorBody.slice(0, 300)}`;
            console.error('[OpenRouter] Réponse HTTP en erreur :', lastError);

            if ([401, 402, 403].includes(response.status)) {
              throw new InternalServerErrorException(
                `OpenRouter a refusé la requête (HTTP ${response.status}). Vérifie la clé API, les crédits et les paramètres de confidentialité du compte.`,
              );
            }
            if (response.status === 404) break;
            if (response.status === 429) {
              await sleep(4000 * attempt);
            }
            continue;
          }

          const payload: any = await response.json();
          const choice = payload.choices?.[0];
          const content: string =
            typeof choice?.message?.content === 'string'
              ? choice.message.content
              : '';

          if (!content.trim()) {
            lastError = `${model}: réponse vide (finish_reason=${choice?.finish_reason})`;
            console.warn(
              '[OpenRouter] Réponse vide :',
              lastError,
              JSON.stringify(choice?.message)?.slice(0, 500),
            );
            continue;
          }

          if (choice?.finish_reason === 'length') {
            console.warn(
              `[OpenRouter] ${model}: réponse tronquée (max_tokens atteint).`,
            );
          }

          const parsed = extractJson(content);
          const result = validate ? validate(parsed) : (parsed as T);
          console.log(`[OpenRouter] ${model}: JSON valide reçu.`);
          return result;
        } catch (error: any) {
          if (error instanceof InternalServerErrorException) throw error;
          lastError = `${model}: ${error?.message ?? error}`;
          console.warn('[OpenRouter] Essai échoué :', lastError);
        }
      }
    }

    console.error('[OpenRouter] Tous les modèles ont échoué :', lastError);
    throw new InternalServerErrorException(
      `OpenRouter : aucune réponse exploitable (${lastError}).`,
    );
  }

  private normalizeAnalysisResult(raw: any): AIResult {
    if (
      !raw ||
      typeof raw.resumeProjet !== 'string' ||
      !raw.resumeProjet.trim() ||
      !Array.isArray(raw.workPhases) ||
      raw.workPhases.length === 0
    ) {
      throw new BadRequestException(
        'La réponse IA ne respecte pas le format attendu (résumé ou phases manquants).',
      );
    }

    const workPhases: AIWorkPhase[] = raw.workPhases.map(
      (phase: any, index: number) => {
        if (typeof phase?.name !== 'string' || !phase.name.trim()) {
          throw new BadRequestException("Une phase de travail n'a pas de nom.");
        }
        return {
          name: phase.name.trim(),
          description: toStr(phase.description),
          order: Math.max(1, toInt(phase.order, index + 1)),
          durationDays: Math.max(1, toInt(phase.durationDays, 1)),
          staff: normalizeStaff(phase.staff),
        };
      },
    );

    const sumPhaseDays = workPhases.reduce((s, p) => s + p.durationDays, 0);
    const durationDays = Math.max(1, toInt(raw.durationDays, sumPhaseDays));

    const workforce: AIWorkforce[] = (
      Array.isArray(raw.workforce) ? raw.workforce : []
    )
      .filter((p: any) => typeof p?.position === 'string')
      .map((p: any) => ({
        position: String(p.position).trim(),
        quantity: Math.max(1, toInt(p.quantity, 1)),
        reason: toStr(p.reason),
      }));

    const lots: AILot[] = (Array.isArray(raw.lots) ? raw.lots : [])
      .filter((l: any) => toStr(l?.name))
      .map((l: any) => {
        const lotDays = Math.min(
          durationDays,
          Math.max(1, toInt(l.durationDays, durationDays)),
        );

        const handlingEquipment: AIHandlingEquipment[] = (
          Array.isArray(l.handlingEquipment) ? l.handlingEquipment : []
        )
          .map((e: any) =>
            typeof e === 'string'
              ? { name: e.trim(), days: lotDays }
              : {
                  name: toStr(e?.name) ?? '',
                  days: Math.min(lotDays, Math.max(1, toInt(e?.days, lotDays))),
                },
          )
          .filter((e: AIHandlingEquipment) => e.name);

        return {
          name: toStr(l.name) as string,
          description: toStr(l.description),
          durationDays: lotDays,
          staff: normalizeStaff(l.staff),
          handlingEquipment,
        };
      });

    const preparations: AIPreparation[] = (
      Array.isArray(raw.preparations) ? raw.preparations : []
    )
      .map((p: any) =>
        typeof p === 'string'
          ? { name: p.trim(), description: null }
          : { name: toStr(p?.name) ?? '', description: toStr(p?.description) },
      )
      .filter((p: AIPreparation) => p.name);

    const hours = Number(raw.workingHoursPerDay);
    const workingHoursPerDay =
      Number.isFinite(hours) && hours > 0 && hours <= 24 ? hours : null;

    const confidenceRaw = Number(raw.confidence);
    const confidence =
      raw.confidence != null &&
      Number.isFinite(confidenceRaw) &&
      confidenceRaw >= 0 &&
      confidenceRaw <= 100
        ? Math.round(confidenceRaw)
        : null;

    const minDays = toInt(raw.minDurationDays, -1);
    const maxDays = toInt(raw.maxDurationDays, -1);

    return {
      resumeProjet: raw.resumeProjet.trim(),
      durationDays,
      minDurationDays: minDays >= 1 ? minDays : null,
      maxDurationDays: maxDays >= 1 ? maxDays : null,
      workingHoursPerDay,
      confidence,
      currency: toStr(raw.currency) ?? 'TND',
      accommodation: toArrangement(raw.accommodation),
      transport: toArrangement(raw.transport),
      riskLevel: toRiskLevel(raw.riskLevel),
      riskReasons: toStringArray(raw.riskReasons),
      evidence: toStringArray(raw.evidence),
      preparations,
      lots,
      workPhases,
      workforce,
      hypotheses: toStringArray(raw.hypotheses),
      missingInformation: toStringArray(raw.missingInformation),
    };
  }
}

function normalizeStaff(raw: unknown): AIPhaseStaff[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s: any) => ({
      position: toStr(s?.position) ?? '',
      quantity: Math.max(0, toInt(s?.quantity, 0)),
    }))
    .filter((s) => s.position && s.quantity > 0);
}