import { Module } from '@nestjs/common';
import { EmployeesService } from './employee.service';
import { EmployeeController } from './employee.controller';

@Module({
  controllers: [EmployeeController],
  providers: [EmployeesService],
})
export class EmployeeModule {}
