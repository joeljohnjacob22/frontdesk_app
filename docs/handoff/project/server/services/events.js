import { ticketEvents } from '../../db/schema.js';

// Who did it. Exactly one shape per actor type (the database enforces the same rule).
export const staffActor = (user) => ({ type: 'staff', userId: user.id });
export const customerActor = (customerId) => ({ type: 'customer', customerId });
export const SYSTEM = Object.freeze({ type: 'system' });

// Append one row to the audit log. Call it INSIDE the transaction of the change it records.
// The database trigger assigns chain_seq, created_at, prev_hash and hash. The placeholder
// hash below only satisfies the NOT NULL column and is always overwritten.
// NEVER put a message body in the payload: use messageId and body_sha256 instead.
export async function logEvent(tx, { ticketId, type, actor, messageId = null, payload = {} }) {
  await tx.insert(ticketEvents).values({
    ticketId,
    type,
    actorType: actor.type,
    actorUserId: actor.userId ?? null,
    actorCustomerId: actor.customerId ?? null,
    messageId,
    payload,
    hash: Buffer.alloc(0),
  });
}
