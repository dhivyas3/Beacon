-- CreateEnum
CREATE TYPE "CheckFrequency" AS ENUM ('manual', 'daily', 'weekly', 'monthly');

-- CreateEnum
CREATE TYPE "PageSelectionMode" AS ENUM ('full', 'static_list', 'random_sample');

-- CreateEnum
CREATE TYPE "TriggerType" AS ENUM ('manual_ui', 'manual_api', 'scheduled', 'n8n', 'monday');

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN     "pageSelectionMode" "PageSelectionMode" NOT NULL DEFAULT 'full',
ADD COLUMN     "pinnedPageUrls" TEXT[],
ADD COLUMN     "previousScanId" TEXT,
ADD COLUMN     "sampleSize" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "staticPageUrls" TEXT[],
ADD COLUMN     "triggeredByType" "TriggerType" NOT NULL DEFAULT 'manual_api',
ADD COLUMN     "websiteId" TEXT;

-- CreateTable
CREATE TABLE "Website" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "checkFrequency" "CheckFrequency" NOT NULL DEFAULT 'weekly',
    "scheduleDayOfWeek" INTEGER,
    "scheduleDayOfMonth" INTEGER,
    "scheduleHourUtc" INTEGER NOT NULL DEFAULT 6,
    "pageSelectionMode" "PageSelectionMode" NOT NULL DEFAULT 'random_sample',
    "staticPageUrls" TEXT[],
    "pinnedPageUrls" TEXT[],
    "sampleSize" INTEGER NOT NULL DEFAULT 10,
    "enabledChecks" TEXT[],
    "formMode" "FormMode" NOT NULL DEFAULT 'validate_only',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3),
    "lastRunError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Website_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebsiteRecipient" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebsiteRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Website_hostname_key" ON "Website"("hostname");

-- CreateIndex
CREATE INDEX "Website_isActive_nextCheckAt_idx" ON "Website"("isActive", "nextCheckAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebsiteRecipient_websiteId_email_key" ON "WebsiteRecipient"("websiteId", "email");

-- CreateIndex
CREATE INDEX "Scan_websiteId_status_finishedAt_idx" ON "Scan"("websiteId", "status", "finishedAt");

-- AddForeignKey
ALTER TABLE "Website" ADD CONSTRAINT "Website_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteRecipient" ADD CONSTRAINT "WebsiteRecipient_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scan" ADD CONSTRAINT "Scan_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scan" ADD CONSTRAINT "Scan_previousScanId_fkey" FOREIGN KEY ("previousScanId") REFERENCES "Scan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill for scans that existed before websites. Scans started from the dashboard were made by a
-- user, everything else came through the API. Each completed scan points at the completed scan
-- before it for the same hostname, which is what the report already compared it with.
UPDATE "Scan" SET "triggeredByType" = 'manual_ui' WHERE "triggeredByUserId" IS NOT NULL;

UPDATE "Scan" AS s
SET "previousScanId" = ordered.previous_id
FROM (
  SELECT "id", LAG("id") OVER (PARTITION BY "hostname" ORDER BY "createdAt", "id") AS previous_id
  FROM "Scan"
  WHERE "status" = 'completed'
) AS ordered
WHERE s."id" = ordered."id" AND ordered.previous_id IS NOT NULL;
