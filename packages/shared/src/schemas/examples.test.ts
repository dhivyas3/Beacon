import { describe, expect, it } from 'vitest';
import { AllowedDomainSchema } from './domain.js';
import { CreatedApiKeySchema, ApiKeySchema } from './api-key.js';
import {
  EXAMPLE_ALLOWED_DOMAIN,
  EXAMPLE_API_KEY,
  EXAMPLE_ISSUE,
  EXAMPLE_PROGRESS,
  EXAMPLE_SCAN,
} from './examples.js';
import { IssueSchema } from './issue.js';
import { ProgressSchema } from './progress.js';
import { ScanSchema } from './scan.js';

describe('OpenAPI examples stay valid', () => {
  it.each([
    ['Progress', ProgressSchema, EXAMPLE_PROGRESS],
    ['Scan', ScanSchema, EXAMPLE_SCAN],
    ['Issue', IssueSchema, EXAMPLE_ISSUE],
    ['ApiKey', ApiKeySchema, EXAMPLE_API_KEY],
    ['AllowedDomain', AllowedDomainSchema, EXAMPLE_ALLOWED_DOMAIN],
  ])('%s example parses against its schema', (_name, schema, example) => {
    const result = schema.safeParse(example);
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it('CreatedApiKey example includes the raw key', () => {
    const parsed = CreatedApiKeySchema.safeParse({ ...EXAMPLE_API_KEY, key: 'qah_abc' });
    expect(parsed.success).toBe(true);
  });
});
