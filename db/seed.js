import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { sql } from 'drizzle-orm';
import { config } from '../server/config.js';
import { createPool, createDb } from './client.js';
import { customers, users } from './schema.js';

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
export const DEMO_CUSTOMER = {
  name: 'Demo Customer',
  email: 'customer@arvo.test',
};

// Idempotent: existing emails are left untouched, so it is safe to run on every deploy.
export async function seedUsers(db, password = config.seedPassword, {
  includeDemoCustomer = !config.isProd,
} = {}) {
  if (config.isProd && password === 'frontdesk-demo') {
    throw new Error('Production seeding requires a non-default SEED_PASSWORD');
  }
  const passwordHash = await bcrypt.hash(password, 10);
  return db.transaction(async (tx) => {
    let customer;
    if (includeDemoCustomer) {
      await tx.insert(customers).values(DEMO_CUSTOMER).onConflictDoNothing();
      [customer] = await tx.select({ id: customers.id }).from(customers)
        .where(sql`lower(${customers.email}) = ${DEMO_CUSTOMER.email.toLowerCase()}`);
      if (!customer) throw new Error('Demo customer record could not be seeded');
    }

    const rows = SEED_USERS.map((user) => ({ ...user, passwordHash }));
    if (customer) {
      rows.push({
        ...DEMO_CUSTOMER,
        passwordHash,
        role: 'customer',
        customerId: customer.id,
      });
    }
    const inserted = await tx.insert(users).values(rows)
      .onConflictDoNothing().returning({ id: users.id });
    return inserted.length;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool();
  try {
    const n = await seedUsers(createDb(pool));
    const total = SEED_USERS.length + (config.isProd ? 0 : 1);
    console.log(`seeded ${n} new user(s) (${total} total defined)`);
  } finally {
    await pool.end();
  }
}
