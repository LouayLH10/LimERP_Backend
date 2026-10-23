-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "dailyRate" DECIMAL(10,3) DEFAULT 0;

-- CreateTable
CREATE TABLE "EmployeeTimeEntry" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "days" DECIMAL(5,2) NOT NULL DEFAULT 1,
    "dailyRateSnapshot" DECIMAL(10,3) NOT NULL,
    "totalAmount" DECIMAL(12,3) NOT NULL,
    "overtimeHours" DECIMAL(5,2) DEFAULT 0,
    "overtimeRate" DECIMAL(10,3) DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeTimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeTimeEntry_projectId_idx" ON "EmployeeTimeEntry"("projectId");

-- CreateIndex
CREATE INDEX "EmployeeTimeEntry_employeeId_idx" ON "EmployeeTimeEntry"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeTimeEntry_employeeId_projectId_date_key" ON "EmployeeTimeEntry"("employeeId", "projectId", "date");

-- AddForeignKey
ALTER TABLE "EmployeeTimeEntry" ADD CONSTRAINT "EmployeeTimeEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTimeEntry" ADD CONSTRAINT "EmployeeTimeEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
