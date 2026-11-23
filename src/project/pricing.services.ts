// =========================================================
// src/project/pricing.services.ts
// Module de chiffrage PUR — aucune dépendance NestJS/Prisma.
// 100 % testable unitairement.
// =========================================================

import { EmployeePosition } from '../generated/prisma/enums';

// ---------- Types ----------

export type HandlingKind =
  | 'grue'
  | 'chariot'
  | 'nacelle'
  | 'echafaudage'
  | 'palan'
  | 'autre';

export type RiskLevel = 'faible' | 'moyen' | 'eleve';

export type Arrangement = 'client' | 'entreprise' | 'non_precise';

export type StaffLine = {
  position: EmployeePosition;
  quantity: number;
};

export type HandlingLine = {
  kind: HandlingKind;
  label: string;
  days: number;
};

/** Lot tel que produit par l'IA (quantités uniquement, aucun prix). */
export type AnalysisLot = {
  name: string;
  description: string | null;
  durationDays: number;
  staff: StaffLine[];
  handling: HandlingLine[];
};

export type PricingRates = {
  mainOeuvre: number;
  heuresSup: number;
  consommables: number;
  logementNuit: number;
  logistique: number;
  manutention: Record<HandlingKind, number>;
  aleas: Record<RiskLevel, number>;
  marge: number;
  calage: number;
};

export type CostComponents = {
  labour: number;
  consumables: number;
  accommodation: number;
  logistics: number;
  handling: number;
};

export type LotQuantities = {
  personDays: number;
  nights: number;
  trips: number;
  handlingDays: number;
};

export type PricedLot = AnalysisLot & {
  headcount: number;
  components: CostComponents;
  quantities: LotQuantities;
  total: number;
};

export type PricingContext = {
  rates: PricingRates;
  hoursFactor: number;
  riskRate: number;
  accommodation: Arrangement;
  transport: Arrangement;
};

// ---------- Helpers ----------

export const round2 = (value: number): number =>
  Math.round(value * 100) / 100;

export function hoursFactor(
  hoursPerDay: number | null,
  overtimeMultiplier: number,
): number {
  const hours = Math.min(Math.max(hoursPerDay ?? 8, 1), 16);
  if (hours <= 8) return 1;
  return (8 + (hours - 8) * overtimeMultiplier) / 8;
}

// ---------- Chiffrage d'un lot ----------

export function priceLot(lot: AnalysisLot, ctx: PricingContext): PricedLot {
  const headcount = lot.staff.reduce((s, x) => s + x.quantity, 0);
  const days = lot.durationDays;
  const factor = (1 + ctx.riskRate) * (1 + ctx.rates.marge) * ctx.rates.calage;

  // Main-d'œuvre : TOUS les employés × jours × tarif unique
  const labour = headcount * days * ctx.rates.mainOeuvre * ctx.hoursFactor;
  const consumables = labour * ctx.rates.consommables;

  // Logement et logistique (0 si pris en charge par le client)
  const nights = ctx.accommodation === 'client' ? 0 : headcount * days;
  const trips = ctx.transport === 'client' ? 0 : headcount * days;
  const accommodation = nights * ctx.rates.logementNuit;
  const logistics = trips * ctx.rates.logistique;

  // Manutention : tarif journalier par type
  const handling = lot.handling.reduce(
    (sum, h) => sum + h.days * ctx.rates.manutention[h.kind],
    0,
  );

  const subtotal = labour + consumables + accommodation + logistics + handling;
  const total = round2(subtotal * factor);

  // Répartition des aléas + marge sur chaque composante pour cohérence
  const components: CostComponents = {
    labour: round2(labour * factor),
    consumables: round2(consumables * factor),
    accommodation: round2(accommodation * factor),
    logistics: round2(logistics * factor),
    handling: round2(handling * factor),
  };

  // Ajustement du dernier centime sur la MO pour que Σ components == total
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
    headcount,
    components,
    quantities: {
      personDays: headcount * days,
      nights,
      trips,
      handlingDays: lot.handling.reduce((s, h) => s + h.days, 0),
    },
    total,
  };
}

// ---------- Chiffrage d'un projet complet ----------

export type PricedProject = {
  lots: PricedLot[];
  totalHT: number;
  totalTVA: number;
  totalTTC: number;
};

export function priceProject(
  lots: AnalysisLot[],
  ctx: PricingContext,
  tvaRate: number,
): PricedProject {
  const pricedLots = lots.map((lot) => priceLot(lot, ctx));
  const totalHT = round2(pricedLots.reduce((s, l) => s + l.total, 0));
  const totalTVA = round2(totalHT * tvaRate);
  const totalTTC = round2(totalHT + totalTVA);

  return { lots: pricedLots, totalHT, totalTVA, totalTTC };
}