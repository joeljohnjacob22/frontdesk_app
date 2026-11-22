import { useEffect, useState } from 'react';
import { Routes, Route, Link } from 'react-router-dom';
import { api } from './api.js';

function Page({ title, children }) {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="mt-4 text-slate-600">{children}</div>
    </main>
  );
}

function Home() {
  const [health, setHealth] = useState('checking...');
  useEffect(() => {
    api('/health').then((h) => setHealth(`API ${h.ok ? 'ok' : 'down'}, database ${h.db}`))
      .catch(() => setHealth('API unreachable'));
  }, []);
  return (
    <Page title="Frontdesk">
      <p className="rounded bg-white p-3 shadow-sm ring-1 ring-slate-200">{health}</p>
      <nav className="mt-4 flex gap-4 text-blue-700 underline">
        <Link to="/login">Agent login</Link>
        <Link to="/new">New ticket</Link>
      </nav>
    </Page>
  );
}

// Placeholders: later steps replace these.
const Login = () => <Page title="Agent login">Coming in step 04.</Page>;
const NewTicket = () => <Page title="Raise a ticket">Coming in step 04.</Page>;
const AgentTickets = () => <Page title="My tickets">Coming in step 04.</Page>;
const TicketDetail = () => <Page title="Ticket">Coming in step 04.</Page>;
const CustomerView = () => <Page title="Your ticket">Coming in step 04.</Page>;
const NotFound = () => <Page title="Not found">That page does not exist.</Page>;

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/new" element={<NewTicket />} />
      <Route path="/tickets" element={<AgentTickets />} />
      <Route path="/tickets/:id" element={<TicketDetail />} />
      <Route path="/t/:token" element={<CustomerView />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
