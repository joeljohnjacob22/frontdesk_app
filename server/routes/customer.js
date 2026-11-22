import express from 'express';
import { formatTicketNo } from '../lib/format.js';
import { requireEmail, requireOneOf, requireString } from '../lib/validate.js';
import { HttpError } from '../lib/errors.js';

const PRIORITIES = ['high', 'medium', 'low'];

export function customerRoutes({ svc, queries }) {
  const router = express.Router();

  router.post('/tickets', async (req, res) => {
    const input = {
      name: requireString(req.body?.name, 'name', { max: 100 }),
      email: requireEmail(req.body?.email),
      subject: requireString(req.body?.subject, 'subject', { max: 200 }),
      body: requireString(req.body?.body, 'body'),
      priority: requireOneOf(req.body?.priority ?? 'medium', 'priority', PRIORITIES),
    };
    const { ticket, token } = await svc.createTicket(input);
    res.status(201).json({
      token,
      link: `/t/${token}`,
      ticket: { ticketNo: formatTicketNo(ticket.ticketNo) },
    });
  });

  router.get('/tickets/:token', async (req, res) => {
    res.json(await queries.getCustomerTicket(req.params.token));
  });

  router.post('/tickets/:token/messages', async (req, res) => {
    const body = requireString(req.body?.body, 'body');
    const result = await svc.customerMessage(req.params.token, body);
    const response = {
      outcome: result.outcome,
      ticketNo: formatTicketNo(result.ticket.ticketNo),
    };
    if (result.outcome === 'new_ticket') {
      response.token = result.token;
      response.link = `/t/${result.token}`;
    }
    res.status(201).json(response);
  });

  router.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'No such API route')));
  return router;
}
