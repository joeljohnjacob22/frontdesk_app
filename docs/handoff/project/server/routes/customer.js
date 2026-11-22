import express from 'express';
import { HttpError } from '../lib/errors.js';
import { formatTicketNo } from '../lib/format.js';
import { requireEmail, requireOneOf, requireString } from '../lib/validate.js';

const PRIORITIES = ['high', 'medium', 'low'];
const EXPORT_FORMATS = ['csv', 'json'];

// No login here. The secret token in the URL IS the credential (only its hash is stored).
// Responses are built from hand-picked fields: nothing internal can ride along by accident.
export function customerRoutes({ svc, queries, exports }) {
  const router = express.Router();

  router.get('/tickets/:token/export', async (req, res) => {
    const format = requireOneOf(req.query.format ?? 'json', 'format', EXPORT_FORMATS);
    const file = await exports.customerTicket(req.params.token, format);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.body);
  });

  // "Raise a ticket". The customer picks how bad it is; an agent can change it later.
  router.post('/tickets', async (req, res) => {
    const input = {
      name: requireString(req.body?.name, 'name', { max: 100 }),
      email: requireEmail(req.body?.email),
      subject: requireString(req.body?.subject, 'subject', { max: 200 }),
      body: requireString(req.body?.body, 'body'),
      priority: requireOneOf(req.body?.priority ?? 'medium', 'priority', PRIORITIES),
    };
    const { ticket, token } = await svc.createTicket(input);
    // The only time the raw token exists outside the customer's link.
    res.status(201).json({ token, link: `/t/${token}`, ticket: { ticketNo: formatTicketNo(ticket.ticketNo) } });
  });

  router.get('/tickets/:token', async (req, res) => {
    res.json(await queries.getCustomerTicket(req.params.token));
  });

  router.post('/tickets/:token/messages', async (req, res) => {
    const body = requireString(req.body?.body, 'body');
    const result = await svc.customerMessage(req.params.token, body);
    const out = { outcome: result.outcome, ticketNo: formatTicketNo(result.ticket.ticketNo) };
    if (result.outcome === 'new_ticket') {            // the customer needs the NEW ticket's link
      out.token = result.token;
      out.link = `/t/${result.token}`;
    }
    res.status(201).json(out);
  });

  router.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'No such API route')));
  return router;
}
