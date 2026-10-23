
import { Module } from '@nestjs/common';
import { ProjectController } from './project.controller';
import { ProjectService } from './project.service';
import { ProjectAiService } from './project-ai.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { ConfigModule } from '@nestjs/config';
import { QuoteModule } from 'src/quote/quote.module';

@Module({
    imports: [ConfigModule,QuoteModule],
  controllers: [ProjectController],
  providers: [ProjectService, ProjectAiService,PrismaService],
})
export class ProjectModule {}
