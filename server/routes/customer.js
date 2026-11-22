import express from 'express';
import { formatTicketNo } from '../lib/format.js';
import { parseId, requireOneOf, requireString } from '../lib/validate.js';
import { HttpError } from '../lib/errors.js';
import { requireCustomer } from '../middleware/auth.js';

const PRIORITIES = ['high', 'medium', 'low'];
const EXPORT_FORMATS = ['csv', 'json'];

function sendExport(res, file) {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.send(file.body);
}

export function customerRoutes({ svc, queries, exports }) {
  const router = express.Router();
  router.use(requireCustomer);

  router.get('/tickets', async (req, res) => {
    res.json({ tickets: await queries.listCustomerTickets(req.user) });
  });

  router.post('/tickets', async (req, res) => {
    const input = {
      subject: requireString(req.body?.subject, 'subject', { max: 200 }),
      body: requireString(req.body?.body, 'body'),
      priority: requireOneOf(req.body?.priority ?? 'medium', 'priority', PRIORITIES),
    };
    const { ticket } = await svc.createTicketForCustomer(req.user, input);
    res.status(201).json({
      ticket: {
        id: ticket.id,
        ticketNo: formatTicketNo(ticket.ticketNo),
      },
    });
  });

  router.get('/tickets/:id/export', async (req, res) => {
    const format = requireOneOf(req.query.format ?? 'json', 'format', EXPORT_FORMATS);
    const file = await exports.customerTicket(parseId(req.params.id), req.user, format);
    sendExport(res, file);
  });

  router.get('/tickets/:id', async (req, res) => {
    res.json(await queries.getCustomerTicket(parseId(req.params.id), req.user));
  });

  router.post('/tickets/:id/messages', async (req, res) => {
    const result = await svc.customerReply(
      req.user,
      parseId(req.params.id),
      requireString(req.body?.body, 'body'),
    );
    res.status(201).json({
      outcome: result.outcome,
      ticketId: result.ticket.id,
      ticketNo: formatTicketNo(result.ticket.ticketNo),
    });
  });

  router.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'No such API route')));
  return router;
}
