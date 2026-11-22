import { ticketEvents } from '../../db/schema.js';

export const SYSTEM = Object.freeze({ type: 'system' });

export function staffActor(user) {
  return { type: 'staff', userId: user.id };
}

export function customerActor(customerId) {
  return { type: 'customer', customerId };
}

// Message body text must never be copied into event payloads.
export async function logEvent(tx, {
  ticketId,
  type,
  actor = SYSTEM,
  messageId = null,
  payload = {},
}) {
  const [event] = await tx.insert(ticketEvents).values({
    ticketId,
    type,
    actorType: actor.type,
    actorUserId: actor.userId ?? null,
    actorCustomerId: actor.customerId ?? null,
    messageId,
    payload,
    hash: Buffer.alloc(0),
  }).returning();
  return event;
}
