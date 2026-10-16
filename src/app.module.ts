import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { EmployeeModule } from './employee/employee.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { QuoteModule } from './quote/quote.module';
import { ClientModule } from './client/client.module';
import { OrderModule } from './order/order.module';
import { DeliveryModule } from './delivery/delivery.module';
import { InvoiceModule } from './invoice/invoice.module';
import { DocumentTemplateModule } from './document-template/document-template.module';
import { ProjectModule } from './project/project.module';

@Module({
  imports: [ PrismaModule,EmployeeModule,AuthModule, UserModule, QuoteModule, ClientModule, OrderModule,DeliveryModule, InvoiceModule, DocumentTemplateModule, ProjectModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
