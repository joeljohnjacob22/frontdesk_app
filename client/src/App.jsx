import { useCallback, useEffect, useState } from 'react';
import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { api } from './api.js';

const VIEWS = [
  ['open', 'Open'],
  ['mine', 'Mine'],
  ['unclaimed', 'Unclaimed'],
  ['waiting', 'Waiting'],
  ['late', 'Late'],
  ['resolved', 'Resolved'],
  ['all', 'All'],
];
const ACTIVE_STATUSES = ['new', 'open', 'waiting_on_customer'];
const dateFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : dateFormatter.format(date);
}

function statusLabel(status) {
  return ({
    new: 'New',
    open: 'Open',
    waiting_on_customer: 'Waiting on customer',
    resolved: 'Resolved',
    closed: 'Closed',
  })[status] ?? status;
}

function friendlyError(error) {
  const messages = {
    already_claimed: 'Another agent claimed this ticket. The latest details have been loaded.',
    claim_required: 'Claim this ticket before replying.',
    not_owner: 'Only the current ticket owner can do that.',
    not_claimable: 'This ticket can no longer be claimed or reassigned.',
    ticket_closed: 'This ticket is no longer active.',
    forbidden: 'You do not have permission to do that.',
  };
  return messages[error?.code] ?? error?.message ?? 'Something went wrong. Please try again.';
}

function useAgentApi() {
  const navigate = useNavigate();
  return useCallback((path, options) => api(path, options).catch((error) => {
    if (error.status === 401) navigate('/login', { replace: true });
    if (error.code === 'password_change_required') navigate('/change-password', { replace: true });
    throw error;
  }), [navigate]);
}

function Page({ title, children, width = 'max-w-5xl' }) {
  return (
    <main className={`mx-auto ${width} px-4 py-8 sm:px-6`}>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-950">{title}</h1>
      <div className="mt-6">{children}</div>
    </main>
  );
}

function Panel({ children, className = '' }) {
  return <section className={`rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 ${className}`}>{children}</section>;
}

function Notice({ children, tone = 'error' }) {
  const styles = tone === 'success'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
    : tone === 'info'
      ? 'border-blue-200 bg-blue-50 text-blue-900'
      : 'border-rose-200 bg-rose-50 text-rose-900';
  return <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border px-4 py-3 text-sm ${styles}`}>{children}</div>;
}

function StatusBadge({ status }) {
  const styles = status === 'waiting_on_customer'
    ? 'bg-amber-100 text-amber-900'
    : status === 'resolved' || status === 'closed'
      ? 'bg-slate-200 text-slate-700'
      : 'bg-blue-100 text-blue-900';
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${styles}`}>{statusLabel(status)}</span>;
}

function DateTime({ value }) {
  return value ? <time dateTime={value}>{formatDate(value)}</time> : <span>—</span>;
}

function Field({ label, id, error, children }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-800">{label}</label>
      {children}
      {error && <p className="mt-1 text-sm text-rose-700">{error}</p>}
    </div>
  );
}

const inputClass = 'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100';
const buttonClass = 'inline-flex items-center justify-center rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButtonClass = 'inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';

function SidebarToggle({ open, onToggle, controls }) {
  return (
    <button
      type="button"
      className={secondaryButtonClass}
      aria-controls={controls}
      aria-expanded={open}
      onClick={onToggle}
    >
      {open ? 'Hide details' : 'Show details'}
    </button>
  );
}

function Home() {
  return (
    <div className="min-h-screen bg-[#f7f8fb]">
      <header className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8">
        <Link className="flex items-center gap-3 text-lg font-bold tracking-tight text-slate-950" to="/">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-700 text-sm font-bold text-white">F</span>
          Frontdesk
        </Link>
        <nav className="flex items-center gap-3 text-sm">
          <Link className="hidden font-medium text-slate-700 hover:text-blue-800 sm:inline" to="/login">Sign in</Link>
          <Link className={`${buttonClass} px-3 py-2`} to="/register">Create account</Link>
        </nav>
      </header>
      <main>
        <section className="relative isolate overflow-hidden bg-gradient-to-br from-slate-950 via-blue-950 to-blue-800">
          <div className="pointer-events-none absolute -right-24 -top-32 h-96 w-96 rounded-full border border-white/10" />
          <div className="pointer-events-none absolute -right-8 -top-16 h-64 w-64 rounded-full border border-white/10" />
          <div className="mx-auto grid max-w-7xl items-center gap-12 px-5 py-20 sm:px-8 sm:py-28 lg:grid-cols-[1.15fr_0.85fr]">
            <div className="relative">
              <span className="inline-flex items-center gap-2 rounded-full border border-blue-200/20 bg-white/10 px-3 py-1.5 text-xs font-medium text-blue-100">
                <span className="h-2 w-2 rounded-full bg-emerald-300" />
                Support that stays with you
              </span>
              <h1 className="mt-6 max-w-2xl text-4xl font-semibold leading-tight tracking-tight text-white sm:text-6xl">
                A little help can make a big difference.
              </h1>
              <p className="mt-5 max-w-xl text-base leading-7 text-blue-100 sm:text-lg">
                Tell us what you need. Our support team will work with you and keep every update in one place.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link className="inline-flex items-center justify-center rounded-lg bg-white px-5 py-3 text-sm font-semibold text-blue-950 shadow-sm hover:bg-blue-50" to="/register">
                  Get support <span aria-hidden="true" className="ml-2">→</span>
                </Link>
                <Link className="inline-flex items-center justify-center rounded-lg border border-white/30 px-5 py-3 text-sm font-semibold text-white hover:bg-white/10" to="/login">
                  Sign in to your account
                </Link>
              </div>
            </div>
            <div className="relative mx-auto w-full max-w-md">
              <div className="rounded-2xl border border-white/15 bg-white/10 p-5 shadow-2xl backdrop-blur-sm sm:p-7">
                <p className="text-sm font-semibold text-blue-100">A clearer path to a solution</p>
                <div className="mt-6 space-y-5">
                  {[
                    ['01', 'Tell us what’s going on', 'Share the details that will help us understand.'],
                    ['02', 'Follow the conversation', 'See replies and add information from your account.'],
                    ['03', 'Get back to what matters', 'Our team will help move things forward.'],
                  ].map(([number, title, description]) => (
                    <div className="flex gap-4" key={number}>
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/15 text-xs font-bold text-white">{number}</span>
                      <div>
                        <h2 className="text-sm font-semibold text-white">{title}</h2>
                        <p className="mt-1 text-sm leading-5 text-blue-100/80">{description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <p className="mt-4 text-center text-xs text-blue-100/70">A human support team, with a record of every update.</p>
            </div>
          </div>
        </section>
        <section className="mx-auto grid max-w-7xl gap-5 px-5 py-12 sm:px-8 md:grid-cols-3">
          {[
            ['New here?', 'Create a customer account to submit and track support requests.', '/register', 'Create an account'],
            ['Already have an account?', 'Sign in to see your tickets and continue a conversation.', '/login', 'Customer sign in'],
            ['Support team', 'Agents and leads can sign in to manage the ticket queue.', '/login', 'Staff sign in'],
          ].map(([title, description, href, action]) => (
            <Panel key={title} className="border border-slate-100 p-6 shadow-sm">
              <h2 className="text-base font-semibold text-slate-950">{title}</h2>
              <p className="mt-2 min-h-12 text-sm leading-6 text-slate-600">{description}</p>
              <Link className="mt-4 inline-flex text-sm font-semibold text-blue-800 hover:underline" to={href}>{action} <span aria-hidden="true" className="ml-1">→</span></Link>
            </Panel>
          ))}
        </section>
      </main>
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-5 text-xs text-slate-500 sm:px-8">
          <span>Frontdesk Support</span>
          <span>Need help signing in? Contact your support administrator.</span>
        </div>
      </footer>
    </div>
  );
}

function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { user } = await api('/auth/login', { method: 'POST', body: { email, password } });
      const destination = user.passwordChangeRequired
        ? '/change-password'
        : user.role === 'customer' ? '/portal' : '/tickets';
      navigate(location.state?.from?.pathname ?? destination, { replace: true });
    } catch (requestError) {
      setError(requestError.status === 401
        ? 'Wrong email or password.'
        : friendlyError(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Welcome back" subtitle="Sign in to continue to your Frontdesk account.">
      <form className="space-y-4" onSubmit={submit}>
        {error && <Notice>{error}</Notice>}
        <Field label="Email address" id="login-email">
          <input id="login-email" className={inputClass} type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field label="Password" id="login-password">
          <input id="login-password" className={inputClass} type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        <button className={`${buttonClass} w-full py-2.5`} type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="text-center text-sm text-slate-600">New to Frontdesk? <Link className="font-semibold text-blue-800 hover:underline" to="/register">Create an account</Link></p>
      </form>
    </AuthFrame>
  );
}

function AuthFrame({ title, subtitle, children }) {
  return (
    <div className="grid min-h-screen bg-[#f7f8fb] lg:grid-cols-2">
      <section className="flex flex-col px-5 py-6 sm:px-10">
        <Link className="flex items-center gap-3 text-lg font-bold text-slate-950" to="/">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-700 text-sm text-white">F</span>
          Frontdesk
        </Link>
        <div className="mx-auto my-auto w-full max-w-md py-12">
          <p className="text-sm font-semibold text-blue-800">Your support, in one place</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">{title}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">{subtitle}</p>
          <div className="mt-8 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:p-8">{children}</div>
        </div>
        <p className="text-xs text-slate-500">If you need help with account access, contact your support administrator.</p>
      </section>
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-slate-950 via-blue-950 to-blue-800 px-12 py-16 text-white lg:flex lg:items-end">
        <div className="absolute -right-20 -top-20 h-96 w-96 rounded-full border border-white/10" />
        <div className="absolute right-8 top-12 h-64 w-64 rounded-full border border-white/10" />
        <div className="relative max-w-lg">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-blue-200">Frontdesk Support</p>
          <p className="mt-5 text-4xl font-semibold leading-tight">Every question deserves a thoughtful answer.</p>
          <p className="mt-4 leading-7 text-blue-100">Stay connected with your support team, follow updates, and keep the full conversation together.</p>
        </div>
      </aside>
    </div>
  );
}

function Register() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setError('');
    if (form.password !== form.confirmPassword) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const { user } = await api('/auth/register', {
        method: 'POST',
        body: { name: form.name, email: form.email, password: form.password },
      });
      navigate(user.passwordChangeRequired ? '/change-password' : '/portal', { replace: true });
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Create your account" subtitle="Join to submit requests and follow every update from your support team.">
      <form className="space-y-4" onSubmit={submit}>
        {error && <Notice>{error}</Notice>}
        <Field label="Your name" id="register-name">
          <input id="register-name" className={inputClass} autoComplete="name" maxLength="100" required value={form.name} onChange={(event) => update('name', event.target.value)} />
        </Field>
        <Field label="Email address" id="register-email">
          <input id="register-email" className={inputClass} type="email" autoComplete="email" maxLength="254" required value={form.email} onChange={(event) => update('email', event.target.value)} />
        </Field>
        <Field label="Password (at least 12 characters)" id="register-password">
          <input id="register-password" className={inputClass} type="password" autoComplete="new-password" minLength="12" maxLength="200" required value={form.password} onChange={(event) => update('password', event.target.value)} />
        </Field>
        <Field label="Confirm password" id="register-confirm-password">
          <input id="register-confirm-password" className={inputClass} type="password" autoComplete="new-password" minLength="12" maxLength="200" required value={form.confirmPassword} onChange={(event) => update('confirmPassword', event.target.value)} />
        </Field>
        <p className="text-xs leading-5 text-slate-500">You can see tickets created from this account. Email verification is not enabled.</p>
        <button className={`${buttonClass} w-full py-2.5`} type="submit" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
        <p className="text-center text-sm text-slate-600">Already have an account? <Link className="font-semibold text-blue-800 hover:underline" to="/login">Sign in</Link></p>
      </form>
    </AuthFrame>
  );
}

function PasswordChange() {
  const request = useAgentApi();
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    request('/auth/me')
      .then((result) => { if (active) setUser(result.user); })
      .catch((requestError) => { if (active && requestError.status !== 401) setError(friendlyError(requestError)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setError('');
    if (form.newPassword !== form.confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const { user: updated } = await request('/auth/change-password', {
        method: 'POST',
        body: { currentPassword: form.currentPassword, newPassword: form.newPassword },
      });
      navigate(updated.role === 'customer' ? '/portal' : '/tickets', { replace: true });
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Page title="Account security"><p role="status">Checking your session…</p></Page>;
  if (!user) return <Navigate to="/login" replace />;

  return (
    <AuthFrame
      title={user.passwordChangeRequired ? 'Choose a new password' : 'Change your password'}
      subtitle={user.passwordChangeRequired
        ? 'Your account has a temporary password. Replace it to continue.'
        : 'Choose a new password to keep your account secure.'}
    >
      <form className="space-y-4" onSubmit={submit}>
        {error && <Notice>{error}</Notice>}
        <Field label="Current password" id="current-password">
          <input id="current-password" className={inputClass} type="password" autoComplete="current-password" required value={form.currentPassword} onChange={(event) => update('currentPassword', event.target.value)} />
        </Field>
        <Field label="New password (at least 12 characters)" id="new-password">
          <input id="new-password" className={inputClass} type="password" autoComplete="new-password" minLength="12" maxLength="200" required value={form.newPassword} onChange={(event) => update('newPassword', event.target.value)} />
        </Field>
        <Field label="Confirm new password" id="confirm-new-password">
          <input id="confirm-new-password" className={inputClass} type="password" autoComplete="new-password" minLength="12" maxLength="200" required value={form.confirmPassword} onChange={(event) => update('confirmPassword', event.target.value)} />
        </Field>
        <button className={`${buttonClass} w-full py-2.5`} type="submit" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button>
      </form>
    </AuthFrame>
  );
}

function AgentLayout() {
  const request = useAgentApi();
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let active = true;
    request('/auth/me')
      .then((result) => {
        if (active) setUser(result.user);
      })
      .catch((requestError) => {
        if (active && requestError.status !== 401) setError(friendlyError(requestError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [request]);

  async function logout() {
    setLoggingOut(true);
    setError('');
    try {
      await request('/auth/logout', { method: 'POST' });
      navigate('/login', { replace: true });
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setLoggingOut(false);
    }
  }

  if (loading) return <Page title="Checking your session…"><p role="status">Loading your account.</p></Page>;
  if (!user) {
    if (error) return <Page title="Agent area"><Notice>{error}</Notice></Page>;
    return <Navigate to="/login" replace />;
  }
  if (user.passwordChangeRequired) return <Navigate to="/change-password" replace />;
  if (user.role === 'customer') return <Navigate to="/portal" replace />;
  if (!['agent', 'lead'].includes(user.role)) return <Navigate to="/login" replace />;

  return (
    <div>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link className="flex items-center gap-2 text-lg font-semibold text-slate-950" to="/tickets">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-blue-700 text-xs text-white">F</span>
            Frontdesk
          </Link>
          <nav className="flex flex-wrap items-center gap-4 text-sm">
            <Link className="font-medium text-blue-800 hover:underline" to="/tickets">Tickets</Link>
            {user.role === 'lead' && <Link className="font-medium text-blue-800 hover:underline" to="/customers">Customers</Link>}
            {user.role === 'lead' && <Link className="font-medium text-blue-800 hover:underline" to="/team">Team</Link>}
            <Link className="font-medium text-slate-600 hover:text-blue-800" to="/change-password">Change password</Link>
            <span className="text-slate-600">{user.name} · {user.role}</span>
            <button type="button" className={secondaryButtonClass} disabled={loggingOut} onClick={logout}>
              {loggingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </nav>
        </div>
      </header>
      {error && <div className="mx-auto mt-4 max-w-5xl px-4 sm:px-6"><Notice>{error}</Notice></div>}
      <Outlet context={{ user }} />
    </div>
  );
}

function CustomerLayout() {
  const request = useAgentApi();
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let active = true;
    request('/auth/me')
      .then((result) => { if (active) setUser(result.user); })
      .catch((requestError) => {
        if (active && requestError.status !== 401) setError(friendlyError(requestError));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request]);

  async function logout() {
    setLoggingOut(true);
    try {
      await request('/auth/logout', { method: 'POST' });
      navigate('/login', { replace: true });
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setLoggingOut(false);
    }
  }

  if (loading) return <Page title="Your support portal"><p role="status">Loading your account…</p></Page>;
  if (!user) return error ? <Page title="Your support portal"><Notice>{error}</Notice></Page> : <Navigate to="/login" replace />;
  if (user.passwordChangeRequired) return <Navigate to="/change-password" replace />;
  if (user.role !== 'customer') return <Navigate to="/tickets" replace />;

  return (
    <div className="min-h-screen bg-[#f7f8fb]">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link className="flex items-center gap-2 text-lg font-bold text-slate-950" to="/portal">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-blue-700 text-xs text-white">F</span>
            Frontdesk
          </Link>
          <nav className="flex flex-wrap items-center gap-3 text-sm">
            <Link className="font-medium text-blue-800 hover:underline" to="/portal">My tickets</Link>
            <Link className={`${buttonClass} px-3 py-2`} to="/portal/new">New request</Link>
            <Link className="font-medium text-slate-600 hover:text-blue-800" to="/change-password">Password</Link>
            <span className="hidden text-slate-600 sm:inline">{user.name}</span>
            <button type="button" className={secondaryButtonClass} disabled={loggingOut} onClick={logout}>
              {loggingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </nav>
        </div>
      </header>
      {error && <div className="mx-auto mt-4 max-w-5xl px-4 sm:px-6"><Notice>{error}</Notice></div>}
      <Outlet context={{ user }} />
      <footer className="mx-auto max-w-6xl px-4 pb-8 text-center text-xs text-slate-500 sm:px-6">
        Your support conversations stay connected to your account.
      </footer>
    </div>
  );
}

function AgentTickets() {
  const request = useAgentApi();
  const [searchParams] = useSearchParams();
  const requestedView = searchParams.get('view') ?? 'open';
  const view = VIEWS.some(([value]) => value === requestedView) ? requestedView : 'open';
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const result = await request(`/agent/tickets?view=${encodeURIComponent(view)}`);
      setTickets(result.tickets);
      setError('');
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setLoading(false);
    }
  }, [request, view]);

  useEffect(() => {
    load(true);
    const timer = window.setInterval(() => load(false), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <Page title="Tickets">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Ticket views" className="flex flex-wrap gap-2">
          {VIEWS.map(([value, label]) => (
            <Link
              key={value}
              to={value === 'open' ? '/tickets' : `/tickets?view=${value}`}
              aria-current={view === value ? 'page' : undefined}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${view === value ? 'bg-blue-700 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100'}`}
            >
              {label}
            </Link>
          ))}
        </nav>
        <button type="button" className={secondaryButtonClass} onClick={() => load(true)}>Refresh</button>
      </div>
      {error && <div className="mt-4"><Notice>{error}</Notice></div>}
      {loading ? (
        <p className="mt-6 text-slate-600" role="status">Loading tickets…</p>
      ) : tickets.length === 0 ? (
        <Panel className="mt-5"><p className="text-slate-600">No tickets in this view.</p></Panel>
      ) : (
        <div className="mt-5 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <ul className="divide-y divide-slate-200">
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <Link to={`/tickets/${ticket.id}`} className="block p-4 hover:bg-slate-50 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-blue-900">{ticket.ticketNo} <span className="font-medium text-slate-950">· {ticket.subject}</span></p>
                      <p className="mt-1 text-sm text-slate-600">{ticket.customerName} · {ticket.assignee?.name ?? 'Unclaimed'}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={ticket.status} />
                      {ticket.isLate && <span className="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-900">Late</span>}
                      {ticket.isMine && <span className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-medium text-violet-900">Mine</span>}
                      {ticket.isUnclaimed && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">Unclaimed</span>}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600">
                    <span>Priority: <strong className="capitalize">{ticket.priority}</strong></span>
                    <span>
                      {ticket.isWaiting
                        ? <>Auto-closes <DateTime value={ticket.autoCloseAt} /></>
                        : <>Next due <DateTime value={ticket.nextDueAt} /></>}
                    </span>
                    <span>Created <DateTime value={ticket.createdAt} /></span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500">This list refreshes every 15 seconds.</p>
    </Page>
  );
}

function TicketDetail() {
  const { id } = useParams();
  const { user } = useOutletContext();
  const request = useAgentApi();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [team, setTeam] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [composerMode, setComposerMode] = useState('reply');
  const [reply, setReply] = useState('');
  const [setWaiting, setSetWaiting] = useState(false);
  const [note, setNote] = useState('');
  const [priority, setPriority] = useState('');
  const [assigneeId, setAssigneeId] = useState('');

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const result = await request(`/agent/tickets/${encodeURIComponent(id)}`);
      setData(result);
      setPriority(result.ticket.priority);
      setAssigneeId(result.ticket.assignee?.id ? String(result.ticket.assignee.id) : '');
      setLoadError('');
    } catch (requestError) {
      setLoadError(friendlyError(requestError));
    } finally {
      setLoading(false);
    }
  }, [id, request]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (user.role !== 'lead') return undefined;
    let active = true;
    request('/agent/users')
      .then((result) => { if (active) setTeam(result.users.filter((member) => member.active && member.role === 'agent')); })
      .catch((requestError) => { if (active) setActionError(friendlyError(requestError)); });
    return () => { active = false; };
  }, [request, user.role]);

  async function mutate(path, options = {}) {
    setActionError('');
    setBusy(true);
    try {
      await request(path, options);
      await load(false);
      return true;
    } catch (requestError) {
      setActionError(friendlyError(requestError));
      if (requestError.code === 'already_claimed') await load(false);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Page title="Ticket"><p role="status">Loading ticket…</p></Page>;
  if (!data) {
    return <Page title="Ticket"><Notice>{loadError || 'Ticket not found.'}</Notice><Link className="mt-4 inline-block text-blue-800 underline" to="/tickets">Back to tickets</Link></Page>;
  }

  const { ticket, messages, events, sla } = data;
  const active = ACTIVE_STATUSES.includes(ticket.status);
  const owner = ticket.assignee?.id === user.id;
  const lead = user.role === 'lead';
  const canReply = owner && ['open', 'waiting_on_customer'].includes(ticket.status);
  const canChangePriority = active && (owner || lead);
  const canClaim = active && ticket.assignee === null;
  const canRelease = active && ticket.assignee && (owner || lead);
  const canReassign = active && lead;
  const canResolve = owner && ['open', 'waiting_on_customer'].includes(ticket.status);
  const activeComposer = canReply && composerMode === 'reply' ? 'reply' : 'note';

  async function submitMessage(event) {
    event.preventDefault();
    if (activeComposer === 'reply') {
      if (!reply.trim()) return;
      const sent = await mutate(`/agent/tickets/${id}/replies`, {
        method: 'POST',
        body: { body: reply, setWaiting },
      });
      if (sent) {
        setReply('');
        setSetWaiting(false);
      }
      return;
    }

    if (!note.trim()) return;
    const added = await mutate(`/agent/tickets/${id}/notes`, {
      method: 'POST',
      body: { body: note },
    });
    if (added) setNote('');
  }

  return (
    <Page title={`${ticket.ticketNo}: ${ticket.subject}`} width="max-w-7xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link className="text-sm font-medium text-blue-800 underline" to="/tickets">← Back to tickets</Link>
        <div className="flex flex-wrap gap-2">
          <a className={secondaryButtonClass} href={`/api/agent/tickets/${encodeURIComponent(id)}/export?format=json`}>Download JSON</a>
          <a className={secondaryButtonClass} href={`/api/agent/tickets/${encodeURIComponent(id)}/export?format=csv`}>Download CSV</a>
          <SidebarToggle
            open={sidebarOpen}
            onToggle={() => setSidebarOpen((open) => !open)}
            controls="agent-ticket-sidebar"
          />
        </div>
      </div>
      {loadError && <div className="mb-4"><Notice>{loadError}</Notice></div>}
      {actionError && <div className="mb-4"><Notice>{actionError}</Notice></div>}
      <div className={`grid items-start gap-4 ${sidebarOpen ? 'lg:grid-cols-[minmax(0,1fr)_20rem]' : 'grid-cols-1'}`}>
        <section aria-label="Ticket conversation">
          <Panel className="flex h-[min(74vh,900px)] min-h-[30rem] flex-col overflow-hidden p-0">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
              <div>
                <h2 className="font-semibold text-slate-950">Conversation</h2>
                <p className="mt-1 text-sm text-slate-600">{ticket.customer.name} · {ticket.assignee?.name ?? 'Unclaimed'}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={ticket.status} />
                {ticket.isLate && <span className="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-900">Late</span>}
              </div>
            </header>
            <ol aria-label="Messages" className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-slate-50/70 p-4 sm:p-6">
              {messages.map((message) => (
                <li
                  key={message.id}
                  className={`flex ${message.kind === 'note' ? 'justify-center' : message.authorType === 'staff' ? 'justify-end' : 'justify-start'}`}
                >
                  <article className={`max-w-[88%] rounded-2xl border px-4 py-3 shadow-sm ${
                    message.kind === 'note'
                      ? 'w-full border-amber-300 bg-amber-50'
                      : message.authorType === 'staff'
                        ? 'border-blue-700 bg-blue-700 text-white'
                        : 'border-slate-200 bg-white text-slate-900'
                  }`}>
                    <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1">
                      <p className={`text-sm font-semibold ${message.authorType === 'staff' && message.kind !== 'note' ? 'text-white' : 'text-slate-900'}`}>
                        {message.authorName}
                        {message.kind === 'note' && <span className="ml-2 rounded bg-amber-200 px-2 py-0.5 text-xs font-bold text-amber-950">Team only</span>}
                      </p>
                      <span className={`text-xs ${message.authorType === 'staff' && message.kind !== 'note' ? 'text-blue-100' : 'text-slate-500'}`}>
                        <DateTime value={message.createdAt} />
                      </span>
                    </div>
                    <p className={`mt-2 whitespace-pre-wrap break-words text-sm leading-6 ${message.authorType === 'staff' && message.kind !== 'note' ? 'text-white' : 'text-slate-800'}`}>
                      {message.body}
                    </p>
                  </article>
                </li>
              ))}
            </ol>
            <div className="border-t border-slate-200 bg-white p-4">
              <div role="group" aria-label="Message type" className="mb-3 flex gap-2">
                {canReply && (
                  <button
                    type="button"
                    className={activeComposer === 'reply' ? buttonClass : secondaryButtonClass}
                    aria-pressed={activeComposer === 'reply'}
                    onClick={() => setComposerMode('reply')}
                  >
                    Reply
                  </button>
                )}
                <button
                  type="button"
                  className={activeComposer === 'note' ? buttonClass : secondaryButtonClass}
                  aria-pressed={activeComposer === 'note'}
                  onClick={() => setComposerMode('note')}
                >
                  Team note
                </button>
              </div>
              <form className="space-y-3" onSubmit={submitMessage}>
                <Field
                  label={activeComposer === 'reply' ? 'Message to customer' : 'Private note for the team'}
                  id="ticket-message"
                >
                  <textarea
                    id="ticket-message"
                    className={inputClass}
                    rows="3"
                    maxLength="10000"
                    required
                    value={activeComposer === 'reply' ? reply : note}
                    onChange={(event) => activeComposer === 'reply' ? setReply(event.target.value) : setNote(event.target.value)}
                  />
                </Field>
                {activeComposer === 'reply' && (
                  <label className="flex items-start gap-2 text-sm text-slate-700">
                    <input className="mt-1" type="checkbox" checked={setWaiting} onChange={(event) => setSetWaiting(event.target.checked)} />
                    <span>Ask a question and mark this ticket as waiting for the customer.</span>
                  </label>
                )}
                <div className="flex justify-end">
                  <button
                    className={activeComposer === 'reply' ? buttonClass : secondaryButtonClass}
                    type="submit"
                    disabled={busy || !(activeComposer === 'reply' ? reply.trim() : note.trim())}
                  >
                    {busy ? 'Sending…' : activeComposer === 'reply' ? 'Send reply' : 'Add team note'}
                  </button>
                </div>
              </form>
            </div>
          </Panel>
        </section>

        <aside id="agent-ticket-sidebar" hidden={!sidebarOpen} aria-label="Ticket details and actions" className="space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto lg:pr-1">
          <Panel>
            <h2 className="text-lg font-semibold text-slate-950">Ticket details</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div><dt className="text-slate-500">Priority</dt><dd className="font-medium capitalize text-slate-900">{ticket.priority}</dd></div>
              <div><dt className="text-slate-500">Customer</dt><dd className="font-medium text-slate-900">{ticket.customer.name}</dd></div>
              <div><dt className="text-slate-500">Email</dt><dd><a className="break-all text-blue-800 underline" href={`mailto:${ticket.customer.email}`}>{ticket.customer.email}</a></dd></div>
              <div><dt className="text-slate-500">Owner</dt><dd className="font-medium text-slate-900">{ticket.assignee?.name ?? 'Unclaimed'}</dd></div>
              {ticket.parentTicketId && <div><dt className="text-slate-500">Linked from ticket ID</dt><dd>{ticket.parentTicketId}</dd></div>}
              {ticket.waitingSince && <div><dt className="text-slate-500">Waiting since</dt><dd><DateTime value={ticket.waitingSince} /></dd></div>}
              {ticket.autoCloseAt && <div><dt className="text-slate-500">Auto-close</dt><dd><DateTime value={ticket.autoCloseAt} /></dd></div>}
              {ticket.reopenUntil && <div><dt className="text-slate-500">Reopen until</dt><dd><DateTime value={ticket.reopenUntil} /></dd></div>}
              <div><dt className="text-slate-500">Created</dt><dd><DateTime value={ticket.createdAt} /></dd></div>
            </dl>
          </Panel>

          <Panel>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-slate-950">Actions</h2>
              <button type="button" className="text-sm font-medium text-blue-800 underline" onClick={() => load(true)}>Refresh</button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {canClaim && <button className={buttonClass} disabled={busy} onClick={() => mutate(`/agent/tickets/${id}/claim`, { method: 'POST', body: {} })}>Claim ticket</button>}
              {canRelease && <button className={secondaryButtonClass} disabled={busy} onClick={() => mutate(`/agent/tickets/${id}/release`, { method: 'POST', body: {} })}>Release ticket</button>}
              {canResolve && <button className={secondaryButtonClass} disabled={busy} onClick={() => mutate(`/agent/tickets/${id}/resolve`, { method: 'POST', body: {} })}>Resolve ticket</button>}
              {!canClaim && !canRelease && !canResolve && <p className="text-sm text-slate-600">No status action is available to you for this ticket.</p>}
            </div>
            {canChangePriority && (
              <form className="mt-5 border-t border-slate-200 pt-4" onSubmit={async (event) => {
                event.preventDefault();
                await mutate(`/agent/tickets/${id}/priority`, { method: 'PATCH', body: { priority } });
              }}>
                <Field label="Priority" id="ticket-priority">
                  <select id="ticket-priority" className={inputClass} value={priority} onChange={(event) => setPriority(event.target.value)}>
                    <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
                  </select>
                </Field>
                <button className={`${secondaryButtonClass} mt-3`} type="submit" disabled={busy || priority === ticket.priority}>Update priority</button>
              </form>
            )}
            {canReassign && (
              <form className="mt-5 border-t border-slate-200 pt-4" onSubmit={async (event) => {
                event.preventDefault();
                if (!assigneeId) return;
                await mutate(`/agent/tickets/${id}/reassign`, { method: 'POST', body: { userId: Number(assigneeId) } });
              }}>
                <Field label="Assign to agent" id="ticket-assignee">
                  <select id="ticket-assignee" className={inputClass} value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} required>
                    <option value="" disabled>Select an agent</option>
                    {team.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
                  </select>
                </Field>
                <button className={`${secondaryButtonClass} mt-3`} type="submit" disabled={busy || !assigneeId || String(ticket.assignee?.id ?? '') === assigneeId}>Reassign</button>
              </form>
            )}
          </Panel>

          <Panel>
            <h2 className="text-lg font-semibold text-slate-950">SLA history</h2>
            {sla.cycles.length === 0 ? <p className="mt-3 text-sm text-slate-600">No SLA cycles.</p> : (
              <div className="mt-4 space-y-3">
                {sla.cycles.map((cycle) => (
                  <div key={cycle.cycleNo} className="rounded-lg border border-slate-200 p-3">
                    <h3 className="font-medium text-slate-900">Cycle {cycle.cycleNo}{cycle.isReopen ? ' · reopened' : ''} · <span className="capitalize">{cycle.priority}</span></h3>
                    <dl className="mt-3 space-y-2 text-sm">
                      <div><dt className="text-slate-500">Clock starts</dt><dd><DateTime value={cycle.clockStartAt} /></dd></div>
                      <div><dt className="text-slate-500">Reply due</dt><dd><DateTime value={cycle.replyDueAt} /></dd></div>
                      <div><dt className="text-slate-500">Resolve due</dt><dd><DateTime value={cycle.resolveDueAt} /></dd></div>
                      {cycle.firstResponseAt && <div><dt className="text-slate-500">First response</dt><dd><DateTime value={cycle.firstResponseAt} /></dd></div>}
                      {cycle.resolvedAt && <div><dt className="text-slate-500">Resolved</dt><dd><DateTime value={cycle.resolvedAt} /></dd></div>}
                      {cycle.replyBreachedAt && <div><dt className="text-rose-700">Reply breached</dt><dd><DateTime value={cycle.replyBreachedAt} /></dd></div>}
                      {cycle.resolveBreachedAt && <div><dt className="text-rose-700">Resolution breached</dt><dd><DateTime value={cycle.resolveBreachedAt} /></dd></div>}
                    </dl>
                  </div>
                ))}
              </div>
            )}
            {sla.pauses.length > 0 && (
              <div className="mt-4">
                <h3 className="font-medium text-slate-900">Customer-wait pauses</h3>
                <ul className="mt-2 space-y-2 text-sm text-slate-700">
                  {sla.pauses.map((pause, index) => (
                    <li key={`${pause.pausedAt}-${index}`} className="rounded-lg bg-slate-50 p-3">
                      <p>Paused <DateTime value={pause.pausedAt} /> · resumed <DateTime value={pause.resumedAt} /></p>
                      <p className="mt-1 text-slate-500">{pause.businessMinutes ?? 'In progress'} business minutes</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>

          <Panel>
            <h2 className="text-lg font-semibold text-slate-950">Audit timeline</h2>
            <ol className="mt-4 space-y-3 border-l border-slate-200 pl-4">
              {events.map((event) => (
                <li key={event.seq} className="relative">
                  <span className="absolute -left-[1.32rem] top-1.5 h-2 w-2 rounded-full bg-blue-600" />
                  <p className="text-sm font-medium text-slate-900">{event.type.replaceAll('_', ' ')}</p>
                  <p className="mt-0.5 text-xs text-slate-600">{event.actorName} · <DateTime value={event.createdAt} /></p>
                  {event.payload && Object.keys(event.payload).length > 0 && (
                    <p className="mt-1 break-words text-xs text-slate-500">{Object.entries(event.payload).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${String(value)}`).join(' · ')}</p>
                  )}
                </li>
              ))}
            </ol>
          </Panel>
        </aside>
      </div>
    </Page>
  );
}

function CustomerTickets() {
  const request = useAgentApi();
  const { user } = useOutletContext();
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const result = await request('/customer/tickets');
      setTickets(result.tickets);
      setError('');
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    load();
    const intervalId = window.setInterval(() => load(false), 15000);
    return () => window.clearInterval(intervalId);
  }, [load]);

  return (
    <Page title={`Good to see you, ${user.name.split(' ')[0]}`} width="max-w-5xl">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-slate-600">Your support requests and conversations, with the latest activity first.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondaryButtonClass} disabled={loading} onClick={() => load(false)}>Refresh</button>
          <Link className={buttonClass} to="/portal/new">Start a support request</Link>
        </div>
      </div>
      {error && <div className="mb-4"><Notice>{error}</Notice></div>}
      {loading ? <p role="status" className="text-sm text-slate-600">Loading your tickets…</p>
        : tickets.length === 0 ? (
          <Panel className="py-12 text-center">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-blue-50 text-2xl text-blue-800">✦</div>
            <h2 className="mt-4 text-lg font-semibold text-slate-950">Nothing in your queue yet</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">When you need help, start a request and our team will follow up here.</p>
            <Link className={`${buttonClass} mt-5`} to="/portal/new">Create your first ticket</Link>
          </Panel>
        ) : (
          <ul className="space-y-3">
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <Link className="block rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:shadow-md" to={`/portal/tickets/${ticket.id}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-blue-800">{ticket.ticketNo}</p>
                      <h2 className="mt-1 text-base font-semibold text-slate-950">{ticket.subject}</h2>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {ticket.hasNewReply && <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-900">New reply</span>}
                      <StatusBadge status={ticket.status} />
                    </div>
                  </div>
                  <p className="mt-3 text-xs text-slate-500">Last activity <DateTime value={ticket.lastActivityAt} /></p>
                </Link>
              </li>
            ))}
          </ul>
        )}
    </Page>
  );
}

function NewTicket() {
  const request = useAgentApi();
  const navigate = useNavigate();
  const { user } = useOutletContext();
  const [form, setForm] = useState({ subject: '', body: '', priority: 'medium' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await request('/customer/tickets', { method: 'POST', body: form });
      navigate(`/portal/tickets/${result.ticket.id}`, { replace: true, state: { created: true } });
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="How can we help?" width="max-w-3xl">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">Submitting as <span className="font-medium text-slate-900">{user.name} · {user.email}</span></p>
        <Link className="text-sm font-medium text-blue-800 hover:underline" to="/portal">← Back to my tickets</Link>
      </div>
      <Panel>
        <p className="mb-5 text-sm leading-6 text-slate-600">Share a few details so our team can get started. You can follow the conversation from your account.</p>
        <form className="space-y-5" onSubmit={submit}>
          {error && <Notice>{error}</Notice>}
          <Field label="What do you need help with?" id="customer-subject">
            <input id="customer-subject" className={inputClass} maxLength="200" required value={form.subject} onChange={(event) => update('subject', event.target.value)} />
          </Field>
          <Field label="Tell us a little more" id="customer-body">
            <textarea id="customer-body" className={inputClass} rows="7" maxLength="10000" required value={form.body} onChange={(event) => update('body', event.target.value)} />
          </Field>
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-slate-800">How much does this affect your work?</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {[
                ['high', 'I cannot work at all'],
                ['medium', 'Something is wrong'],
                ['low', 'I have a question'],
              ].map(([value, label]) => (
                <label key={value} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${form.priority === value ? 'border-blue-600 bg-blue-50 ring-1 ring-blue-200' : 'border-slate-200 hover:bg-slate-50'}`}>
                  <input type="radio" name="priority" value={value} checked={form.priority === value} onChange={(event) => update('priority', event.target.value)} />
                  <span><span className="block text-sm font-medium text-slate-900">{label}</span><span className="text-xs capitalize text-slate-500">{value} priority</span></span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
            <button className={buttonClass} type="submit" disabled={busy}>{busy ? 'Submitting…' : 'Submit request'}</button>
            <p className="text-xs text-slate-500">Your account is the only way to view this conversation.</p>
          </div>
        </form>
      </Panel>
    </Page>
  );
}

function ExportLinks({ id }) {
  const base = `/api/customer/tickets/${encodeURIComponent(id)}/export`;
  return (
    <div className="flex flex-wrap gap-2">
      <a className={secondaryButtonClass} href={`${base}?format=json`}>Download JSON</a>
      <a className={secondaryButtonClass} href={`${base}?format=csv`}>Download CSV</a>
    </div>
  );
}

function CustomerDetail() {
  const { id } = useParams();
  const location = useLocation();
  const request = useAgentApi();
  const navigate = useNavigate();
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTicket(await request(`/customer/tickets/${encodeURIComponent(id)}`));
      setError('');
    } catch (requestError) {
      setTicket(null);
      setError(friendlyError(requestError));
    } finally {
      setLoading(false);
    }
  }, [id, request]);

  useEffect(() => { load(); }, [load]);

  async function submitReply(event) {
    event.preventDefault();
    if (!reply.trim()) return;
    setBusy(true);
    setError('');
    setOutcome(null);
    try {
      const result = await request(`/customer/tickets/${encodeURIComponent(id)}/messages`, {
        method: 'POST',
        body: { body: reply },
      });
      setReply('');
      if (result.outcome === 'new_ticket') {
        navigate(`/portal/tickets/${result.ticketId}`, { replace: true, state: { linked: true } });
      } else {
        setOutcome(result);
        await load();
      }
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Page title="Your ticket" width="max-w-7xl"><p role="status">Loading your ticket…</p></Page>;
  if (!ticket) return <Page title="Your ticket" width="max-w-7xl"><Notice>{error || 'Ticket not found.'}</Notice><Link className="mt-4 inline-block text-blue-800 underline" to="/portal">Back to my tickets</Link></Page>;

  return (
    <Page title={`${ticket.ticketNo}: ${ticket.subject}`} width="max-w-7xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link className="text-sm font-medium text-blue-800 hover:underline" to="/portal">← My tickets</Link>
        <SidebarToggle
          open={sidebarOpen}
          onToggle={() => setSidebarOpen((open) => !open)}
          controls="customer-ticket-sidebar"
        />
      </div>
      {location.state?.created && <div className="mb-4"><Notice tone="success">Your request was submitted. You can follow all updates here.</Notice></div>}
      {location.state?.linked && <div className="mb-4"><Notice tone="success">A new ticket was created from your reply. Its conversation is now open below.</Notice></div>}
      {ticket.status === 'waiting_on_customer' && <div className="mb-4"><Notice tone="info">The support team is waiting for your reply.</Notice></div>}
      {ticket.status === 'resolved' && ticket.canReopen && (
        <div className="mb-4"><Notice tone="info">This ticket is resolved. Reply before <DateTime value={ticket.reopenUntil} /> to reopen it.</Notice></div>
      )}
      {(ticket.status === 'closed' || (ticket.status === 'resolved' && !ticket.canReopen)) && (
        <div className="mb-4"><Notice tone="info">This ticket is closed. Your reply will create a new linked ticket.</Notice></div>
      )}
      {error && <div className="mb-4"><Notice>{error}</Notice></div>}
      {outcome?.outcome === 'replied' && <div className="mb-4"><Notice tone="success">Your reply was added to this ticket.</Notice></div>}
      {outcome?.outcome === 'reopened' && <div className="mb-4"><Notice tone="success">Your reply reopened this ticket and started a new support cycle.</Notice></div>}
      <div className={`grid items-start gap-4 ${sidebarOpen ? 'lg:grid-cols-[minmax(0,1fr)_20rem]' : 'grid-cols-1'}`}>
        <section aria-label="Ticket conversation">
          <Panel className="flex h-[min(74vh,900px)] min-h-[30rem] flex-col overflow-hidden p-0">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
              <div>
                <h2 className="font-semibold text-slate-950">Conversation</h2>
                <p className="mt-1 text-sm text-slate-600">Replies from you and the support team</p>
              </div>
              <StatusBadge status={ticket.status} />
            </header>
            <ol aria-label="Messages" className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-slate-50/70 p-4 sm:p-6">
            {ticket.messages.map((message) => (
              <li key={message.id} className={`flex ${message.authorType === 'customer' ? 'justify-end' : 'justify-start'}`}>
                <article className={`max-w-[88%] rounded-2xl border px-4 py-3 shadow-sm ${
                  message.authorType === 'customer'
                    ? 'border-blue-700 bg-blue-700 text-white'
                    : 'border-slate-200 bg-white text-slate-900'
                }`}>
                  <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1">
                    <p className={`text-sm font-semibold ${message.authorType === 'customer' ? 'text-white' : 'text-slate-900'}`}>{message.authorName}</p>
                    <span className={`text-xs ${message.authorType === 'customer' ? 'text-blue-100' : 'text-slate-500'}`}><DateTime value={message.createdAt} /></span>
                  </div>
                  <p className={`mt-2 whitespace-pre-wrap break-words text-sm leading-6 ${message.authorType === 'customer' ? 'text-white' : 'text-slate-800'}`}>{message.body}</p>
                </article>
              </li>
            ))}
            </ol>
            <form className="space-y-3 border-t border-slate-200 bg-white p-4" onSubmit={submitReply}>
              <Field label="Your message" id="customer-reply">
                <textarea id="customer-reply" className={inputClass} rows="3" maxLength="10000" required value={reply} onChange={(event) => setReply(event.target.value)} />
              </Field>
              <div className="flex justify-end">
                <button className={buttonClass} type="submit" disabled={busy || !reply.trim()}>{busy ? 'Sending…' : 'Send reply'}</button>
              </div>
            </form>
          </Panel>
        </section>
        <aside id="customer-ticket-sidebar" hidden={!sidebarOpen} aria-label="Ticket details and actions" className="space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto lg:pr-1">
          <Panel>
            <h2 className="text-lg font-semibold text-slate-950">Ticket details</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div><dt className="text-slate-500">Ticket</dt><dd className="font-medium text-slate-900">{ticket.ticketNo}</dd></div>
              <div><dt className="text-slate-500">Status</dt><dd><StatusBadge status={ticket.status} /></dd></div>
              <div><dt className="text-slate-500">Created</dt><dd><DateTime value={ticket.createdAt} /></dd></div>
              {ticket.resolvedAt && <div><dt className="text-slate-500">Resolved</dt><dd><DateTime value={ticket.resolvedAt} /></dd></div>}
              {ticket.reopenUntil && <div><dt className="text-slate-500">Reopen until</dt><dd><DateTime value={ticket.reopenUntil} /></dd></div>}
              {ticket.closedAt && <div><dt className="text-slate-500">Closed</dt><dd><DateTime value={ticket.closedAt} /></dd></div>}
            </dl>
          </Panel>
          <Panel>
            <h2 className="text-lg font-semibold text-slate-950">Actions</h2>
            <ExportLinks id={id} />
            <p className="mt-3 text-sm text-slate-600">Download a copy of this conversation or reply in the chat to continue it.</p>
          </Panel>
        </aside>
      </div>
    </Page>
  );
}

function LeadCustomers() {
  const { user } = useOutletContext();
  const request = useAgentApi();
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmId, setConfirmId] = useState(null);
  const [reset, setReset] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await request('/agent/customers');
      setCustomers(result.customers);
      setError('');
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setLoading(false);
    }
  }, [request]);
  useEffect(() => { load(); }, [load]);

  async function resetPassword(customer) {
    setError('');
    setReset(null);
    setBusyId(customer.id);
    try {
      const result = await request(`/agent/customers/${customer.id}/password-reset`, {
        method: 'POST',
        body: {},
      });
      setReset({ id: customer.id, name: customer.name, password: result.temporaryPassword });
      setConfirmId(null);
      await load();
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setBusyId(null);
    }
  }

  if (user.role !== 'lead') return <Navigate to="/tickets" replace />;
  return (
    <Page title="Customer accounts" width="max-w-5xl">
      <p className="mb-5 text-sm text-slate-600">Manage customer accounts and issue a temporary password when someone loses access.</p>
      {error && <div className="mb-4"><Notice>{error}</Notice></div>}
      {reset && (
        <div className="mb-5">
          <Notice tone="success">
            Temporary password for {reset.name}. Share it securely; it is shown only once and must be changed at next sign in.
            <input className={`${inputClass} mt-3 font-mono`} aria-label="Temporary password" readOnly value={reset.password} onFocus={(event) => event.target.select()} />
          </Notice>
        </div>
      )}
      <Panel className="overflow-hidden p-0">
        {loading ? <p role="status" className="p-5 text-sm text-slate-600">Loading customer accounts…</p>
          : customers.length === 0 ? <p className="p-5 text-sm text-slate-600">No customer accounts yet.</p>
            : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[42rem] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr><th className="px-5 py-3 font-medium">Customer</th><th className="px-5 py-3 font-medium">Account created</th><th className="px-5 py-3 font-medium">Password</th><th className="px-5 py-3 font-medium">Action</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {customers.map((customer) => (
                      <tr key={customer.id}>
                        <td className="px-5 py-4"><p className="font-medium text-slate-900">{customer.name}</p><p className="text-xs text-slate-500">{customer.email}</p></td>
                        <td className="px-5 py-4 text-slate-600"><DateTime value={customer.createdAt} /></td>
                        <td className="px-5 py-4">{customer.passwordChangeRequired ? <span className="text-amber-800">Change required</span> : <span className="text-emerald-800">Set</span>}</td>
                        <td className="px-5 py-4">
                          {confirmId === customer.id ? (
                            <div className="flex gap-2">
                              <button className={buttonClass} type="button" disabled={busyId === customer.id} onClick={() => resetPassword(customer)}>{busyId === customer.id ? 'Resetting…' : 'Confirm reset'}</button>
                              <button className={secondaryButtonClass} type="button" onClick={() => setConfirmId(null)}>Cancel</button>
                            </div>
                          ) : (
                            <button className={secondaryButtonClass} type="button" onClick={() => { setReset(null); setConfirmId(customer.id); }}>Reset password</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      </Panel>
    </Page>
  );
}

function LeadAgents() {
  const { user } = useOutletContext();
  const request = useAgentApi();
  const [agents, setAgents] = useState([]);
  const [form, setForm] = useState({ name: '', email: '' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await request('/agent/users');
      setAgents(result.users.filter((member) => member.role === 'agent'));
      setError('');
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setLoading(false);
    }
  }, [request]);
  useEffect(() => { load(); }, [load]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setError('');
    setCreated(null);
    setBusy(true);
    try {
      const result = await request('/agent/users', { method: 'POST', body: form });
      setCreated(result);
      setForm({ name: '', email: '' });
      await load();
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setBusy(false);
    }
  }

  if (user.role !== 'lead') return <Navigate to="/tickets" replace />;
  return (
    <Page title="Team" width="max-w-5xl">
      <p className="mb-5 text-sm text-slate-600">Add agents to the support team. New agents receive a temporary password and must change it when they sign in.</p>
      {error && <div className="mb-4"><Notice>{error}</Notice></div>}
      {created && (
        <div className="mb-5">
          <Notice tone="success">
            Created {created.agent.name} ({created.agent.email}). Share this temporary password securely; it is shown only once and must be changed at first sign in.
            <input className={`${inputClass} mt-3 font-mono`} aria-label="Temporary agent password" readOnly value={created.temporaryPassword} onFocus={(event) => event.target.select()} />
          </Notice>
        </div>
      )}
      <Panel className="mb-5">
        <h2 className="text-lg font-semibold text-slate-950">Add an agent</h2>
        <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={submit}>
          <Field label="Agent name" id="agent-name">
            <input id="agent-name" className={inputClass} maxLength="100" required value={form.name} onChange={(event) => update('name', event.target.value)} />
          </Field>
          <Field label="Email address" id="agent-email">
            <input id="agent-email" className={inputClass} type="email" maxLength="254" required value={form.email} onChange={(event) => update('email', event.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <button className={buttonClass} type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create agent'}</button>
          </div>
        </form>
      </Panel>
      <Panel className="overflow-hidden p-0">
        {loading ? <p role="status" className="p-5 text-sm text-slate-600">Loading agents…</p>
          : agents.length === 0 ? <p className="p-5 text-sm text-slate-600">No agents have been added.</p>
            : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[32rem] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr><th className="px-5 py-3 font-medium">Agent</th><th className="px-5 py-3 font-medium">Email</th><th className="px-5 py-3 font-medium">Status</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {agents.map((agent) => (
                      <tr key={agent.id}>
                        <td className="px-5 py-4 font-medium text-slate-900">{agent.name}</td>
                        <td className="px-5 py-4 text-slate-600">{agent.email}</td>
                        <td className="px-5 py-4">{agent.active ? <span className="text-emerald-800">Active</span> : <span className="text-slate-500">Inactive</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      </Panel>
    </Page>
  );
}

function LegacyTicketNotice() {
  return (
    <Page title="Sign in to view your tickets" width="max-w-2xl">
      <Panel>
        <p className="text-sm leading-6 text-slate-600">Private ticket links are no longer available. Sign in to your customer account to see tickets created from that account. For older requests, contact the support team.</p>
        <Link className={`${buttonClass} mt-5`} to="/login">Sign in</Link>
      </Panel>
    </Page>
  );
}

function NotFound() {
  return (
    <Page title="Not found" width="max-w-2xl">
      <Panel>
        <p className="text-slate-700">That page does not exist.</p>
        <Link className="mt-3 inline-block text-blue-800 underline" to="/">Go to Frontdesk</Link>
      </Panel>
    </Page>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/change-password" element={<PasswordChange />} />
      <Route path="/new" element={<Navigate to="/portal/new" replace />} />
      <Route element={<AgentLayout />}>
        <Route path="/tickets" element={<AgentTickets />} />
        <Route path="/tickets/:id" element={<TicketDetail />} />
        <Route path="/customers" element={<LeadCustomers />} />
        <Route path="/team" element={<LeadAgents />} />
      </Route>
      <Route element={<CustomerLayout />}>
        <Route path="/portal" element={<CustomerTickets />} />
        <Route path="/portal/new" element={<NewTicket />} />
        <Route path="/portal/tickets/:id" element={<CustomerDetail />} />
      </Route>
      <Route path="/t/:token" element={<LegacyTicketNotice />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
