// ai/schemas/analysis.schema.ts
import { z } from 'zod';
import { EmployeePosition } from 'src/generated/prisma/enums';

const staffSchema = z.object({
  position: z.nativeEnum(EmployeePosition),
  quantity: z.number().int().min(1).max(200),
});

const handlingSchema = z.object({
  kind: z.enum(['grue', 'chariot', 'nacelle', 'echafaudage', 'palan', 'autre']),
  label: z.string().min(1).max(120),   // ex: "Grue mobile 50T"
  days: z.number().int().min(1).max(365),
});

const lotSchema = z.object({
  name: z.string().min(3).max(200),
  description: z.string().max(1000).nullable(),
  durationDays: z.number().int().min(1).max(365),
  staff: z.array(staffSchema).min(1),
  handling: z.array(handlingSchema).default([]),
});

export const analysisSchema = z.object({
  resumeProjet: z.string().min(20).max(3000),
  durationDays: z.number().int().min(1).max(365),
  workingHoursPerDay: z.number().min(1).max(24).nullable(),
  confidence: z.number().int().min(0).max(100).nullable(),
  currency: z.literal('TND').default('TND'),
  accommodation: z.enum(['client', 'entreprise', 'non_precise']),
  transport: z.enum(['client', 'entreprise', 'non_precise']),
  riskLevel: z.enum(['faible', 'moyen', 'eleve']),
  riskReasons: z.array(z.string()).max(5),
  evidence: z.array(z.string()).max(5),
  preparations: z.array(z.object({
    name: z.string(),
    description: z.string().nullable(),
  })).max(10),
  lots: z.array(lotSchema).min(1).max(20),
  workPhases: z.array(z.object({
    name: z.string(),
    description: z.string().nullable(),
    order: z.number().int().min(1),
    durationDays: z.number().int().min(1),
    staff: z.array(staffSchema).default([]),
  })).min(1),
  workforce: z.array(z.object({
    position: z.nativeEnum(EmployeePosition),
    quantity: z.number().int().min(1),
    reason: z.string().nullable(),
  })),
  hypotheses: z.array(z.string()),
  missingInformation: z.array(z.string()),
});

export type Analysis = z.infer<typeof analysisSchema>;