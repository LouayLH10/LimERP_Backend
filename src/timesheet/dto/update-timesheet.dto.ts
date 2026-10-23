import { PartialType } from '@nestjs/mapped-types';
import { CreateTimeSheetDto } from './create-timesheet.dto';

export class  UpdateTimeSheetDto extends PartialType(CreateTimeSheetDto) {}
