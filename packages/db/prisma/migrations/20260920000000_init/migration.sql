-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'member');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('queued', 'discovering', 'running', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ScanStage" AS ENUM ('pages', 'links', 'finalising');

-- CreateEnum
CREATE TYPE "FormMode" AS ENUM ('detect', 'validate_only', 'submit');

-- CreateEnum
CREATE TYPE "PageStatus" AS ENUM ('pending', 'done', 'error');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('critical', 'warning', 'info');

-- CreateEnum
CREATE TYPE "IssueState" AS ENUM ('open', 'ignored');

-- CreateEnum
CREATE TYPE "LinkKind" AS ENUM ('internal', 'external');

-- CreateEnum
CREATE TYPE "LinkState" AS ENUM ('pending', 'done');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllowedDomain" (
    "id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AllowedDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostnameCounter" (
    "hostname" TEXT NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "HostnameCounter_pkey" PRIMARY KEY ("hostname")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Scan" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "runNumber" INTEGER NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'queued',
    "stage" "ScanStage",
    "checks" TEXT[],
    "formMode" "FormMode" NOT NULL DEFAULT 'detect',
    "callbackUrl" TEXT,
    "metadata" JSONB,
    "idempotencyKey" TEXT,
    "triggeredByUserId" TEXT,
    "triggeredByApiKeyId" TEXT,
    "pagesFound" INTEGER NOT NULL DEFAULT 0,
    "pagesTotal" INTEGER NOT NULL DEFAULT 0,
    "pagesDone" INTEGER NOT NULL DEFAULT 0,
    "linksTotal" INTEGER NOT NULL DEFAULT 0,
    "linksChecked" INTEGER NOT NULL DEFAULT 0,
    "criticalCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "passedCount" INTEGER NOT NULL DEFAULT 0,
    "healthScore" INTEGER,
    "avgPageMs" DOUBLE PRECISION,
    "avgLinkMs" DOUBLE PRECISION,
    "pageConcurrency" INTEGER NOT NULL DEFAULT 5,
    "linkConcurrency" INTEGER NOT NULL DEFAULT 10,
    "seedDurationMs" INTEGER,
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanPage" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" "PageStatus" NOT NULL DEFAULT 'pending',
    "httpStatus" INTEGER,
    "durationMs" INTEGER,
    "template" TEXT,
    "criticalCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ScanPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanIssue" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "pageId" TEXT,
    "checkType" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "selector" TEXT,
    "resourceUrl" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "screenshotPath" TEXT,
    "state" "IssueState" NOT NULL DEFAULT 'open',
    "ignoreNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckResult" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "checkType" TEXT NOT NULL,
    "pagesChecked" INTEGER NOT NULL DEFAULT 0,
    "issuesFound" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CheckResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanLink" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" "LinkKind" NOT NULL,
    "state" "LinkState" NOT NULL DEFAULT 'pending',
    "httpStatus" INTEGER,
    "redirectHops" INTEGER NOT NULL DEFAULT 0,
    "finalUrl" TEXT,
    "error" TEXT,
    "checkedAt" TIMESTAMP(3),

    CONSTRAINT "ScanLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanLinkSource" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "selector" TEXT,
    "text" TEXT,

    CONSTRAINT "ScanLinkSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "responseStatus" INTEGER,
    "error" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE UNIQUE INDEX "AllowedDomain_hostname_key" ON "AllowedDomain"("hostname");

-- CreateIndex
CREATE UNIQUE INDEX "Scan_idempotencyKey_key" ON "Scan"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Scan_hostname_status_idx" ON "Scan"("hostname", "status");

-- CreateIndex
CREATE INDEX "Scan_status_createdAt_idx" ON "Scan"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Scan_createdAt_idx" ON "Scan"("createdAt");

-- CreateIndex
CREATE INDEX "Scan_status_heartbeatAt_idx" ON "Scan"("status", "heartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "Scan_hostname_runNumber_key" ON "Scan"("hostname", "runNumber");

-- CreateIndex
CREATE INDEX "ScanPage_scanId_status_idx" ON "ScanPage"("scanId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ScanPage_scanId_url_key" ON "ScanPage"("scanId", "url");

-- CreateIndex
CREATE INDEX "ScanIssue_scanId_severity_idx" ON "ScanIssue"("scanId", "severity");

-- CreateIndex
CREATE INDEX "ScanIssue_scanId_fingerprint_idx" ON "ScanIssue"("scanId", "fingerprint");

-- CreateIndex
CREATE INDEX "ScanIssue_scanId_checkType_idx" ON "ScanIssue"("scanId", "checkType");

-- CreateIndex
CREATE INDEX "ScanIssue_scanId_createdAt_idx" ON "ScanIssue"("scanId", "createdAt");

-- CreateIndex
CREATE INDEX "ScanIssue_pageId_idx" ON "ScanIssue"("pageId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckResult_scanId_checkType_key" ON "CheckResult"("scanId", "checkType");

-- CreateIndex
CREATE INDEX "ScanLink_scanId_state_idx" ON "ScanLink"("scanId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ScanLink_scanId_url_key" ON "ScanLink"("scanId", "url");

-- CreateIndex
CREATE INDEX "ScanLinkSource_pageId_idx" ON "ScanLinkSource"("pageId");

-- CreateIndex
CREATE UNIQUE INDEX "ScanLinkSource_linkId_pageId_key" ON "ScanLinkSource"("linkId", "pageId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_scanId_idx" ON "WebhookDelivery"("scanId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllowedDomain" ADD CONSTRAINT "AllowedDomain_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scan" ADD CONSTRAINT "Scan_triggeredByUserId_fkey" FOREIGN KEY ("triggeredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scan" ADD CONSTRAINT "Scan_triggeredByApiKeyId_fkey" FOREIGN KEY ("triggeredByApiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanPage" ADD CONSTRAINT "ScanPage_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanIssue" ADD CONSTRAINT "ScanIssue_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanIssue" ADD CONSTRAINT "ScanIssue_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "ScanPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckResult" ADD CONSTRAINT "CheckResult_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanLink" ADD CONSTRAINT "ScanLink_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanLinkSource" ADD CONSTRAINT "ScanLinkSource_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "ScanLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanLinkSource" ADD CONSTRAINT "ScanLinkSource_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "ScanPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one active scan per hostname. Backs the 409 duplicate-scan guard and makes it race-free.
-- Prisma cannot express partial indexes, so this is maintained by hand.
CREATE UNIQUE INDEX "Scan_one_active_per_hostname"
  ON "Scan" ("hostname")
  WHERE "status" IN ('queued', 'discovering', 'running');
