-- AlterTable
ALTER TABLE "ProjectAIAnalysis" ADD COLUMN     "assumptions" TEXT,
ADD COLUMN     "missingInformation" TEXT,
ADD COLUMN     "rawResponse" TEXT,
ADD COLUMN     "summary" TEXT;

-- AlterTable
ALTER TABLE "ProjectSpecification" ADD COLUMN     "extractedText" TEXT;
