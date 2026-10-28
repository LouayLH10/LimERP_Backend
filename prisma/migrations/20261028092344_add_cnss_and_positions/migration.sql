-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EmployeePosition" ADD VALUE 'MECHANIC';
ALTER TYPE "EmployeePosition" ADD VALUE 'BOILERMAKER';
ALTER TYPE "EmployeePosition" ADD VALUE 'PIPEFITTER';
ALTER TYPE "EmployeePosition" ADD VALUE 'HSE_OFFICER';
ALTER TYPE "EmployeePosition" ADD VALUE 'HELPER';
ALTER TYPE "EmployeePosition" ADD VALUE 'ELECTRICIAN';
ALTER TYPE "EmployeePosition" ADD VALUE 'STOREKEEPER';
ALTER TYPE "EmployeePosition" ADD VALUE 'LOGISTICS_MANAGER';
ALTER TYPE "EmployeePosition" ADD VALUE 'SALES_REPRESENTATIVE';
ALTER TYPE "EmployeePosition" ADD VALUE 'SUPERVISOR';

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "cnssNumber" TEXT;
