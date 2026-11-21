import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { config } from '../server/config.js';
import { createPool, createDb } from './client.js';
import { users } from './schema.js';

export const SEED_USERS = [
  { name: 'Meera Nair',    email: 'meera@arvo.test',  role: 'lead' },
  { name: 'Anil Kumar',    email: 'anil@arvo.test',   role: 'agent' },
  { name: 'Priya Menon',   email: 'priya@arvo.test',  role: 'agent' },
  { name: 'Rahul Varma',   email: 'rahul@arvo.test',  role: 'agent' },
  { name: 'Sneha Pillai',  email: 'sneha@arvo.test',  role: 'agent' },
  { name: 'Arjun Das',     email: 'arjun@arvo.test',  role: 'agent' },
  { name: 'Divya Thomas',  email: 'divya@arvo.test',  role: 'agent' },
  { name: 'Faisal Rahman', email: 'faisal@arvo.test', role: 'agent' },
  { name: 'Lakshmi Iyer',  email: 'lakshmi@arvo.test', role: 'agent' },
  { name: 'Joseph Mathew', email: 'joseph@arvo.test', role: 'agent' },
];

// Idempotent: existing emails are left untouched, so it is safe to run on every deploy.
export async function seedUsers(db, password = config.seedPassword) {
  const passwordHash = await bcrypt.hash(password, 10);
  const rows = SEED_USERS.map((u) => ({ ...u, passwordHash }));
  const inserted = await db.insert(users).values(rows).onConflictDoNothing().returning({ id: users.id });
  return inserted.length;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool();
  try {
    const n = await seedUsers(createDb(pool));
    console.log(`seeded ${n} new user(s) (${SEED_USERS.length} total defined)`);
  } finally {
    await pool.end();
  }
}
