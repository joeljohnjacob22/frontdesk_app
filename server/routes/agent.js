import express from 'express';
import { formatTicketNo } from '../lib/format.js';
import { optionalBoolean, parseId, requireEmail, requireOneOf, requireString } from '../lib/validate.js';
import { requireAgent, requireLead } from '../middleware/auth.js';
import { LIST_VIEWS } from '../services/queries.js';

const PRIORITIES = ['high', 'medium', 'low'];
const EXPORT_FORMATS = ['csv', 'json'];

function brief(ticket) {
  return {
    id: ticket.id,
    ticketNo: formatTicketNo(ticket.ticketNo),
    status: ticket.status,
    priority: ticket.priority,
    assigneeId: ticket.assigneeId,
  };
}

function sendExport(res, file) {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.send(file.body);
}

export function agentRoutes({ svc, queries, exports, accounts }) {
  const router = express.Router();
  router.use(requireAgent);

  router.get('/tickets', async (req, res) => {
    const view = requireOneOf(req.query.view ?? 'open', 'view', LIST_VIEWS);
    res.json({ tickets: await queries.listTickets(req.user, view) });
  });

  router.get('/tickets/:id/export', async (req, res) => {
    const format = requireOneOf(req.query.format ?? 'json', 'format', EXPORT_FORMATS);
    const includeNotes = req.query.include_notes === undefined
      ? false
      : requireOneOf(req.query.include_notes, 'include_notes', ['true', 'false']) === 'true';
    const file = await exports.agentTicket(
      parseId(req.params.id),
      req.user,
      format,
      includeNotes,
    );
    sendExport(res, file);
  });

  router.get('/tickets/:id', async (req, res) => {
    res.json(await queries.getAgentTicket(parseId(req.params.id)));
  });

  router.post('/tickets/:id/claim', async (req, res) => {
    const ticket = await svc.claimTicket(parseId(req.params.id), req.user);
    res.json({ ticket: brief(ticket) });
  });

  router.post('/tickets/:id/release', async (req, res) => {
    const ticket = await svc.releaseTicket(parseId(req.params.id), req.user);
    res.json({ ticket: brief(ticket) });
  });

  router.post('/tickets/:id/reassign', async (req, res) => {
    const toUserId = parseId(req.body?.userId);
    const ticket = await svc.reassignTicket(parseId(req.params.id), req.user, toUserId);
    res.json({ ticket: brief(ticket) });
  });

  router.post('/tickets/:id/replies', async (req, res) => {
    const body = requireString(req.body?.body, 'body');
    const setWaiting = optionalBoolean(req.body?.setWaiting, 'setWaiting');
    const { message, ticket } = await svc.replyPublic(parseId(req.params.id), req.user, {
      body,
      setWaiting,
    });
    res.status(201).json({ messageId: message.id, ticket: brief(ticket) });
  });

  router.post('/tickets/:id/notes', async (req, res) => {
    const message = await svc.addNote(
      parseId(req.params.id),
      req.user,
      requireString(req.body?.body, 'body'),
    );
    res.status(201).json({ messageId: message.id });
  });

  router.patch('/tickets/:id/priority', async (req, res) => {
    const priority = requireOneOf(req.body?.priority, 'priority', PRIORITIES);
    const ticket = await svc.setPriority(parseId(req.params.id), req.user, priority);
    res.json({ ticket: brief(ticket) });
  });

  router.post('/tickets/:id/resolve', async (req, res) => {
    const ticket = await svc.resolveTicket(parseId(req.params.id), req.user);
    res.json({ ticket: brief(ticket) });
  });

  router.get('/users', requireLead, async (_req, res) => {
    res.json({ users: await queries.listUsers() });
  });

  router.post('/users', requireLead, async (req, res) => {
    const result = await accounts.createAgent({
      name: requireString(req.body?.name, 'name', { max: 100 }),
      email: requireEmail(req.body?.email).toLowerCase(),
    });
    res.status(201).json(result);
  });

  router.get('/customers', requireLead, async (_req, res) => {
    res.json({ customers: await queries.listCustomerAccounts() });
  });

  router.post('/customers/:id/password-reset', requireLead, async (req, res) => {
    const temporaryPassword = await accounts.resetCustomerPassword(parseId(req.params.id));
    res.json({ temporaryPassword });
  });

  return router;
}
