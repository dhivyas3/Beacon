import { z } from 'zod';
import { EXAMPLE_ALLOWED_DOMAIN } from './examples.js';

const HOSTNAME_PATTERN =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export const AllowedDomainSchema = z
  .object({
    id: z.string(),
    hostname: z.string(),
    note: z.string().nullable(),
    createdAt: z.iso.datetime(),
    createdByName: z.string().nullable(),
  })
  .meta({ id: 'AllowedDomain', example: EXAMPLE_ALLOWED_DOMAIN });
export type AllowedDomain = z.infer<typeof AllowedDomainSchema>;

export const CreateAllowedDomainBodySchema = z
  .object({
    hostname: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(253)
      .regex(HOSTNAME_PATTERN, 'Enter a hostname such as example.com or *.example.com.'),
    note: z.string().trim().max(200).optional(),
  })
  .meta({
    id: 'CreateAllowedDomainBody',
    example: { hostname: '*.example-estates.co.uk', note: 'Client site and subdomains' },
  });
export type CreateAllowedDomainBody = z.infer<typeof CreateAllowedDomainBodySchema>;
