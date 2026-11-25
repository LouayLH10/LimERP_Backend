-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "consommables_responsible" TEXT,
ADD COLUMN     "duration_days" INTEGER,
ADD COLUMN     "employee_daily_rate" INTEGER,
ADD COLUMN     "manutention_percentage" DOUBLE PRECISION;
