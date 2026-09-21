import { hash } from '@node-rs/argon2';
import { newId } from '@beacon/shared';
import { createDb } from './index.js';

/**
 * Creates the first admin from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD (and SEED_ADMIN_NAME).
 * Safe to run repeatedly: an existing user with that email is left untouched.
 */
async function main(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME?.trim() || 'Admin';

  if (!email || !password) {
    throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to create the first admin.');
  }
  if (password.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters.');
  }

  const db = createDb();
  try {
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`Admin ${email} already exists. Nothing to do.`);
      return;
    }
    const passwordHash = await hash(password);
    await db.user.create({
      data: { id: newId('usr'), email, name, passwordHash, role: 'admin' },
    });
    console.log(`Created admin ${email}.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
