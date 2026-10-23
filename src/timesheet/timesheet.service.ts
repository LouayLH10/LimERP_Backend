import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTimeSheetDto } from './dto/create-timesheet.dto';
import { UpdateTimeSheetDto } from './dto/update-timesheet.dto';

@Injectable()
export class TimesheetService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Pointage : enregistre les jours travaillés pour un employé sur un projet.
   * - Si une entrée existe déjà pour (employee, project, date) → mise à jour.
   * - Sinon → création.
   */
  async upsert(projectId: string, dto: CreateTimeSheetDto) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new NotFoundException('Projet introuvable.');

    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
    });
    if (!employee) throw new NotFoundException('Employé introuvable.');

    // Vérifier que l'employé est affecté au projet
    const assignment = await this.prisma.projectEmployee.findFirst({
      where: {
        projectId,
        employeeId: dto.employeeId,
      },
    });
    if (!assignment) {
      throw new BadRequestException(
        "Cet employé n'est pas affecté à ce projet.",
      );
    }

    const dailyRate = Number(employee.dailyRate ?? 0);
    if (dailyRate <= 0) {
      throw new BadRequestException(
        "Le taux journalier de l'employé n'est pas défini. Un super administrateur doit le renseigner.",
      );
    }

    const days = dto.days ?? 1;
    const overtimeHours = dto.overtimeHours ?? 0;
    const overtimeRate = dto.overtimeRate ?? 0;

    const baseAmount = days * dailyRate;
    const overtimeAmount = overtimeHours * overtimeRate;
    const totalAmount = baseAmount + overtimeAmount;

    // Normaliser la date (00:00:00)
    const dateObj = new Date(dto.date);
    dateObj.setUTCHours(0, 0, 0, 0);

    return this.prisma.employeeTimeEntry.upsert({
      where: {
        employeeId_projectId_date: {
          employeeId: dto.employeeId,
          projectId,
          date: dateObj,
        },
      },
      create: {
        employeeId: dto.employeeId,
        projectId,
        date: dateObj,
        days,
        dailyRateSnapshot: dailyRate,
        overtimeHours,
        overtimeRate,
        totalAmount,
        notes: dto.notes ?? null,
      },
      update: {
        days,
        dailyRateSnapshot: dailyRate,
        overtimeHours,
        overtimeRate,
        totalAmount,
        notes: dto.notes ?? null,
      },
      include: {
        employee: true,
      },
    });
  }

  async findByProject(projectId: string) {
    return this.prisma.employeeTimeEntry.findMany({
      where: { projectId },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      include: { employee: true },
    });
  }

  async findByProjectAndEmployee(projectId: string, employeeId: string) {
    return this.prisma.employeeTimeEntry.findMany({
      where: { projectId, employeeId },
      orderBy: { date: 'desc' },
    });
  }

  async update(id: string, dto: UpdateTimeSheetDto) {
    const entry = await this.prisma.employeeTimeEntry.findUnique({
      where: { id },
    });
    if (!entry) throw new NotFoundException('Pointage introuvable.');

    const days = dto.days ?? Number(entry.days);
    const dailyRate = Number(entry.dailyRateSnapshot);
    const overtimeHours = dto.overtimeHours ?? Number(entry.overtimeHours ?? 0);
    const overtimeRate = dto.overtimeRate ?? Number(entry.overtimeRate ?? 0);

    const totalAmount =
      days * dailyRate + overtimeHours * overtimeRate;

    return this.prisma.employeeTimeEntry.update({
      where: { id },
      data: {
        days,
        overtimeHours,
        overtimeRate,
        totalAmount,
        notes: dto.notes ?? entry.notes,
      },
    });
  }

  async remove(id: string) {
    const entry = await this.prisma.employeeTimeEntry.findUnique({
      where: { id },
    });
    if (!entry) throw new NotFoundException('Pointage introuvable.');

    await this.prisma.employeeTimeEntry.delete({ where: { id } });
    return { success: true };
  }

  /**
   * Résumé par employé pour un projet.
   */
  async summaryByProject(projectId: string) {
    const entries = await this.prisma.employeeTimeEntry.findMany({
      where: { projectId },
      include: { employee: true },
    });

    const map = new Map<
      string,
      {
        employeeId: string;
        employee: (typeof entries)[number]['employee'];
        totalDays: number;
        totalAmount: number;
        entriesCount: number;
      }
    >();

    for (const entry of entries) {
      const key = entry.employeeId;
      const current = map.get(key) ?? {
        employeeId: entry.employeeId,
        employee: entry.employee,
        totalDays: 0,
        totalAmount: 0,
        entriesCount: 0,
      };
      current.totalDays += Number(entry.days);
      current.totalAmount += Number(entry.totalAmount);
      current.entriesCount += 1;
      map.set(key, current);
    }

    return Array.from(map.values()).sort((a, b) =>
      a.employee.lastName.localeCompare(b.employee.lastName),
    );
  }
}