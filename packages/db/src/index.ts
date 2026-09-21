import { PrismaClient } from '@prisma/client';

export { Prisma, PrismaClient } from '@prisma/client';
export type {
  ApiKey,
  AllowedDomain,
  CheckFrequency,
  CheckResult,
  DeliveryStatus,
  EmailDelivery,
  FormMode,
  IssueState,
  LinkKind,
  LinkState,
  NotifyPreference,
  PageSelectionMode,
  PageStatus,
  Role,
  Scan,
  ScanIssue,
  ScanLink,
  ScanLinkSource,
  ScanPage,
  ScanStage,
  ScanStatus,
  Session,
  Severity,
  TriggerType,
  User,
  WebhookDelivery,
  Website,
  WebsiteRecipient,
} from '@prisma/client';

export type Db = PrismaClient;

export interface CreateDbOptions {
  url?: string;
  log?: boolean;
}

export function createDb(options: CreateDbOptions = {}): Db {
  return new PrismaClient({
    ...(options.url ? { datasources: { db: { url: options.url } } } : {}),
    log: options.log === false ? [] : ['warn', 'error'],
  });
}

/** Postgres error code for unique constraint violations, as reported by Prisma. */
export const UNIQUE_VIOLATION = 'P2002';

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === UNIQUE_VIOLATION
  );
}
export * from './scans.js';
export * from './settings.js';
