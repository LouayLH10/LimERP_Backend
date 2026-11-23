-- CreateTable
CREATE TABLE "ProjectAILot" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "durationDays" INTEGER NOT NULL,
    "headcount" INTEGER NOT NULL,
    "personDays" INTEGER NOT NULL,
    "staff" JSONB NOT NULL,
    "handling" JSONB NOT NULL,

    CONSTRAINT "ProjectAILot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectAIComponent" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unit" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "weight" DECIMAL(5,2) NOT NULL,

    CONSTRAINT "ProjectAIComponent_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ProjectAILot" ADD CONSTRAINT "ProjectAILot_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "ProjectAIAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAIComponent" ADD CONSTRAINT "ProjectAIComponent_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ProjectAILot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
