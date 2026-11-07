-- CreateTable
CREATE TABLE "PriceSchedule" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "totalHT" DECIMAL(10,3) NOT NULL,
    "totalTVA" DECIMAL(10,3) NOT NULL,
    "totalTTC" DECIMAL(10,3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PriceSchedule_analysisId_key" ON "PriceSchedule"("analysisId");

-- AddForeignKey
ALTER TABLE "PriceSchedule" ADD CONSTRAINT "PriceSchedule_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "ProjectAIAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
