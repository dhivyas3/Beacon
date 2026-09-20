import { z } from 'zod';
import { ROLES, SCOPES } from '../constants.js';

export const UserSchema = z
  .object({
    id: z.string(),
    email: z.email(),
    name: z.string(),
    role: z.enum(ROLES),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'User' });
export type User = z.infer<typeof UserSchema>;

export const LoginBodySchema = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  password: z.string().min(1).max(200),
});
export type LoginBody = z.infer<typeof LoginBodySchema>;

export const SessionResponseSchema = z
  .object({
    user: UserSchema,
    scopes: z.array(z.enum(SCOPES)),
  })
  .meta({ id: 'SessionResponse' });
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
