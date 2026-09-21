-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('pending', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "NotifyPreference" AS ENUM ('every_check', 'new_issues_only');

-- AlterTable
ALTER TABLE "WebhookDelivery" ADD COLUMN     "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Website" ADD COLUMN     "emailEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "WebsiteRecipient" ADD COLUMN     "notify" "NotifyPreference" NOT NULL DEFAULT 'every_check';

-- CreateTable
CREATE TABLE "EmailDelivery" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "websiteId" TEXT,
    "recipientId" TEXT,
    "email" TEXT NOT NULL,
    "subject" TEXT,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "providerMessageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailDelivery_websiteId_createdAt_idx" ON "EmailDelivery"("websiteId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDelivery_scanId_email_key" ON "EmailDelivery"("scanId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_scanId_event_key" ON "WebhookDelivery"("scanId", "event");

-- AddForeignKey
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "WebsiteRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

