
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Injectable()
export class ProjectService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new project with its team
   */
  async create(createProjectDto: CreateProjectDto) {
    const {
      name,
      description,
      location,
      startDate,
      endDate,
      clientId,
      employeeIds = [],
    } = createProjectDto;

    // 1. Check that the client exists
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
    });

    if (!client) {
      throw new NotFoundException('Client not found');
    }

    // 2. Validate dates
    const parsedStartDate = startDate
      ? new Date(startDate)
      : undefined;

    const parsedEndDate = endDate
      ? new Date(endDate)
      : undefined;

    if (
      parsedStartDate &&
      parsedEndDate &&
      parsedEndDate < parsedStartDate
    ) {
      throw new BadRequestException(
        'End date cannot be before start date',
      );
    }

    // 3. Prevent duplicate employees
    if (new Set(employeeIds).size !== employeeIds.length) {
      throw new BadRequestException(
        'A team member cannot be assigned more than once',
      );
    }

    // 4. Check that all employees exist and are active
    if (employeeIds.length > 0) {
      const employees = await this.prisma.employee.findMany({
        where: {
          id: { in: employeeIds },
          isActive: true,
        },
        select: { id: true },
      });

      if (employees.length !== employeeIds.length) {
        throw new BadRequestException(
          'One or more team members do not exist or are inactive',
        );
      }
    }
console.log(employeeIds)
    // 5. Create the project and its team
    return this.prisma.project.create({
      data: {
        name,
        description,
        location,
        startDate: parsedStartDate,
        endDate: parsedEndDate,

        client: {
          connect: { id: clientId },
        },

        projectEmployees: {
          create: employeeIds.map((employeeId) => ({
            employee: {
              connect: { id: employeeId },
            },
            isProjectManager: false,
          })),
        },
      },
      include: {
        client: true,
        projectEmployees: {
          include: {
            employee: true,
          },
        },
      },
    });
  }

  /**
   * Get all projects
   */
  async findAll() {
    return this.prisma.project.findMany({
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        client: true,
        projectEmployees: {
          include: {
            employee: true,
          },
        },
        _count: {
          select: {
            quotes: true,
            orders: true,
            deliveries: true,
            invoices: true,
          },
        },
      },
    });
  }

  /**
   * Get one project
   */
  async findOne(id: string) {
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: {
        client: true,
        projectEmployees: {
          include: {
            employee: true,
          },
        },
        quotes: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        orders: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        deliveries: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        invoices: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        specification: true,
        aiAnalyses: {
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return project;
  }

  /**
   * Update a project
   */
  async update(
    id: string,
    updateProjectDto: UpdateProjectDto,
  ) {
    const existingProject = await this.prisma.project.findUnique({
      where: { id },
    });

    if (!existingProject) {
      throw new NotFoundException('Project not found');
    }

    const {
      name,
      description,
      location,
      startDate,
      endDate,
      clientId,
    } = updateProjectDto;

    // Check the new client if clientId changes
    if (clientId && clientId !== existingProject.clientId) {
      const client = await this.prisma.client.findUnique({
        where: { id: clientId },
      });

      if (!client) {
        throw new NotFoundException('Client not found');
      }
    }

    // Calculate final dates
    const finalStartDate =
      startDate !== undefined
        ? startDate
          ? new Date(startDate)
          : null
        : existingProject.startDate;

    const finalEndDate =
      endDate !== undefined
        ? endDate
          ? new Date(endDate)
          : null
        : existingProject.endDate;

    // Validate dates
    if (
      finalStartDate &&
      finalEndDate &&
      finalEndDate < finalStartDate
    ) {
      throw new BadRequestException(
        'End date cannot be before start date',
      );
    }

    return this.prisma.project.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(location !== undefined && { location }),

        ...(startDate !== undefined && {
          startDate: finalStartDate,
        }),

        ...(endDate !== undefined && {
          endDate: finalEndDate,
        }),

        ...(clientId !== undefined && {
          client: {
            connect: { id: clientId },
          },
        }),
      },
      include: {
        client: true,
        projectEmployees: {
          include: {
            employee: true,
          },
        },
      },
    });
  }

  /**
   * Delete a project
   */
  async remove(id: string) {
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            quotes: true,
            orders: true,
            deliveries: true,
            invoices: true,
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    // Prevent deleting a project associated with commercial documents
    if (
      project._count.quotes > 0 ||
      project._count.orders > 0 ||
      project._count.deliveries > 0 ||
      project._count.invoices > 0
    ) {
      throw new BadRequestException(
        'This project cannot be deleted because it is already associated with commercial documents.',
      );
    }

    return this.prisma.project.delete({
      where: { id },
    });
  }
}
