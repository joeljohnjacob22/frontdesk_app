import bcrypt from 'bcryptjs';
import { and, eq, sql } from 'drizzle-orm';
import { customers, users } from '../../db/schema.js';
import { HttpError } from '../lib/errors.js';
import { newToken } from '../lib/tokens.js';

function emailInUse() {
  return new HttpError(409, 'email_in_use', 'An account already uses this email');
}

export function createAccountService({ db }) {
  return {
    async registerCustomer({ name, email, password }) {
      const passwordHash = await bcrypt.hash(password, 10);
      try {
        return await db.transaction(async (tx) => {
          const [existing] = await tx.select({ id: users.id }).from(users)
            .where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
          if (existing) throw emailInUse();

          await tx.insert(customers).values({ name, email }).onConflictDoNothing();
          const [customer] = await tx.select({ id: customers.id }).from(customers)
            .where(sql`lower(${customers.email}) = ${email.toLowerCase()}`)
            .for('update');
          if (!customer) throw new Error('Customer account could not be associated with a customer record');

          const [user] = await tx.insert(users).values({
            name,
            email,
            passwordHash,
            role: 'customer',
            customerId: customer.id,
          }).returning();
          return user;
        });
      } catch (error) {
        if (error.cause?.code === '23505') throw emailInUse();
        throw error;
      }
    },

    async createAgent({ name, email }) {
      const temporaryPassword = newToken();
      const passwordHash = await bcrypt.hash(temporaryPassword, 10);
      const [agent] = await db.insert(users).values({
        name,
        email,
        passwordHash,
        role: 'agent',
        passwordChangeRequired: true,
      }).onConflictDoNothing().returning({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        active: users.active,
        passwordChangeRequired: users.passwordChangeRequired,
      });
      if (!agent) throw emailInUse();
      return { agent, temporaryPassword };
    },

    async changePassword(userId, currentPassword, newPassword) {
      return db.transaction(async (tx) => {
        const [user] = await tx.select().from(users)
          .where(and(eq(users.id, userId), eq(users.active, true)))
          .for('update');
        if (!user) throw new HttpError(401, 'unauthenticated', 'Please sign in');

        if (!await bcrypt.compare(currentPassword, user.passwordHash)) {
          throw new HttpError(400, 'invalid_current_password', 'Current password is incorrect');
        }
        if (await bcrypt.compare(newPassword, user.passwordHash)) {
          throw new HttpError(400, 'validation_error', 'Choose a password different from your current password');
        }

        const passwordHash = await bcrypt.hash(newPassword, 10);
        const [updated] = await tx.update(users).set({
          passwordHash,
          passwordChangeRequired: false,
          updatedAt: sql`clock_timestamp()`,
        }).where(eq(users.id, userId)).returning();
        return updated;
      });
    },

    async resetCustomerPassword(userId) {
      const temporaryPassword = newToken();
      const passwordHash = await bcrypt.hash(temporaryPassword, 10);
      const [updated] = await db.update(users).set({
        passwordHash,
        passwordChangeRequired: true,
        updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(users.id, userId),
        eq(users.role, 'customer'),
        eq(users.active, true),
      )).returning({ id: users.id });
      if (!updated) throw new HttpError(404, 'customer_not_found', 'Customer account not found');
      return temporaryPassword;
    },
  };
}
