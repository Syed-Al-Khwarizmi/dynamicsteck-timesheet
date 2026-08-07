import express from 'express';
import ExcelJS from 'exceljs';
import { hashPassword, verifyPassword, newSessionToken, hashToken, suggestPassword } from './src/auth.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from './src/db.js';

const root = dirname(fileURLToPath(import.meta.url));
const store = await Db.open({
  file: join(root, 'data', 'timesheet.db'),
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '256kb' }));

// ---------------------------------------------------------------------------
// Accounts and sessions
//
// Credentials live in the database, not in an environment variable. An env var
// password is a shell-quoting hazard: `set PW=secret && npm start` in cmd stores
// a trailing space, and the correct password is then rejected with no clue why.
// ---------------------------------------------------------------------------
const SESSION_DAYS = 7;
const COOKIE = 'tt_session';

/**
 * Setting ADMIN_PASSWORD creates or resets that administrator on every boot.
 *
 * This exists because hosts with no shell - Render's free plan among them -
 * leave no other way in if the first-run password scrolls out of the deploy
 * log. Set the variable, redeploy, sign in, then delete the variable.
 */
const seedEmail = (process.env.ADMIN_EMAIL ?? 'admin@local').toLowerCase().trim();
const seedPassword = process.env.ADMIN_PASSWORD ?? '';

if (seedPassword) {
  if (seedPassword.length < 8) {
    console.error('\n  ADMIN_PASSWORD must be at least 8 characters. Ignoring it.\n');
  } else {
    const passwordHash = await hashPassword(seedPassword);
    const existing = (await store.listEmployees()).find((e) => e.email.toLowerCase() === seedEmail);

    if (existing) {
      await store.setPassword(existing.id, passwordHash);
      await store.updateEmployee(existing.id, { role: 'admin', active: true });
      // A password change ends existing sessions, here as everywhere else.
      await store.deleteSessionsForUser(existing.id);
    } else {
      const created = await store.insertEmployee({
        name: await store.uniqueName('Administrator'),
        email: seedEmail,
        title: 'Administrator',
        role: 'admin',
        passwordHash,
      });
      await store.audit({
        actorName: 'system', action: 'employee.create', entity: 'employee',
        entityId: created.id, summary: `Created ${seedEmail} from ADMIN_PASSWORD`,
      });
    }

    console.log('\n  ---------------------------------------------------------');
    console.log(`   ADMIN_PASSWORD is set, so ${seedEmail} can sign in with it.`);
    console.log('   Remove that environment variable once you are in: while it');
    console.log('   is set, the password resets on every restart.');
    console.log('  ---------------------------------------------------------');
  }
}

// First run with no administrator: create one and print the credentials once.
if (await store.countAdmins() === 0) {
  const password = suggestPassword();
  const admin = await store.insertEmployee({
    // An upgraded database may already contain someone called "Administrator";
    // colliding with the unique name index here would crash the server at boot.
    name: await store.uniqueName('Administrator'),
    email: 'admin@local',
    title: 'Administrator',
    role: 'admin',
    passwordHash: await hashPassword(password),
  });
  await store.audit({
    actorId: null, actorName: 'system', action: 'user.create',
    entity: 'employee', entityId: admin.id, summary: 'Created the first administrator',
  });
  console.log('\n  ---------------------------------------------------------');
  console.log('   First run. An administrator account has been created:');
  console.log(`     Email:    admin@local`);
  console.log(`     Password: ${password}`);
  console.log('   Change it from the Employees tab after signing in.');
  console.log('   This is printed once and is not stored anywhere in plain text.');
  console.log('  ---------------------------------------------------------');
}

/**
 * A real hash to verify against when the account does not exist, so a missing
 * email costs the same time as a wrong password. Without it, response latency
 * tells an attacker which addresses have accounts.
 */
const DUMMY_HASH = await hashPassword(newSessionToken());

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

const setSessionCookie = (res, token) =>
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`,
  );

// Throttle by email, not by address: several people behind one office NAT must
// not lock each other out, and it is the account being guessed at that matters.
const attempts = new Map();

app.use(async (req, _res, next) => {
  const token = readCookie(req, COOKIE);
  req.sessionToken = token;
  req.user = token ? await store.findSessionUser(hashToken(token)) : null;
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/login', async (req, res) => {
  const email = clean(req.body?.email).toLowerCase();
  const password = String(req.body?.password ?? '');

  const record = attempts.get(email) ?? { count: 0, lockedUntil: 0 };
  if (record.lockedUntil > Date.now()) {
    const seconds = Math.ceil((record.lockedUntil - Date.now()) / 1000);
    return res.status(429).json({ error: `Too many attempts. Try again in ${seconds} seconds.` });
  }

  const row = await store.findEmployeeByEmail(email);
  // Always run the KDF, including for unknown accounts and for people who have
  // no password set, so every failure path takes the same time.
  const passwordMatches = await verifyPassword(password, row?.password_hash || DUMMY_HASH);
  const ok = passwordMatches && Boolean(row?.password_hash);

  if (!ok) {
    record.count += 1;
    if (record.count >= 8) {
      record.lockedUntil = Date.now() + 60_000;
      record.count = 0;
    }
    attempts.set(email, record);
    // One message for both causes: distinguishing them confirms which addresses
    // have accounts.
    return res.status(401).json({ error: 'That email and password do not match an account' });
  }

  attempts.delete(email);
  await store.purgeExpiredSessions();

  const token = newSessionToken();
  await store.createSession(
    hashToken(token),
    row.id,
    new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString(),
  );
  await store.recordLogin(row.id);
  await store.audit({ actorId: row.id, actorName: row.name, action: 'auth.login', entity: 'session', entityId: row.id });

  setSessionCookie(res, token);
  res.json({ ok: true });
});

app.post('/api/logout', async (req, res) => {
  if (req.sessionToken) await store.deleteSession(hashToken(req.sessionToken));
  if (req.user) {
    await store.audit({ actorId: req.user.id, actorName: req.user.name, action: 'auth.logout', entity: 'session' });
  }
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue' });
  res.json({ ...req.user, currency: (await store.getSettings()).currency });
});

app.use('/api', (req, res, next) => {
  if (req.user) return next();
  res.status(401).json({ error: 'Sign in to continue' });
});

/** Admin-only guard for anything that changes people, projects or settings. */
function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Only an administrator can do that' });
}

const isAdmin = (req) => req.user?.role === 'admin';

/** Every mutation records who did it. */
const trail = (req, action, entity, entityId, summary, detail = {}) =>
  store.audit({ actorId: req.user.id, actorName: req.user.name, action, entity, entityId, summary, detail });

app.use(express.static(join(root, 'public')));

// ---------------------------------------------------------------------------
// Validation. Small and explicit rather than a schema library — there are only
// three shapes, and a bad number here becomes a wrong invoice later.
// ---------------------------------------------------------------------------
const clean = (v) => String(v ?? '').trim();

function bad(res, message) {
  res.status(400).json({ error: message });
  return null;
}

/** Accepts 1.5, 1:30 and 1h30m so people can type what they are used to. */
function parseHours(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const raw = clean(input).toLowerCase();
  if (!raw) return null;

  let m;
  if ((m = raw.match(/^(\d{1,2}):([0-5]\d)$/))) return Number(m[1]) + Number(m[2]) / 60;
  if ((m = raw.match(/^(\d{1,2})\s*h(?:\s*(\d{1,2})\s*m)?$/))) return Number(m[1]) + Number(m[2] ?? 0) / 60;
  if ((m = raw.match(/^(\d{1,3})\s*m$/))) return Number(m[1]) / 60;
  if (/^\d{0,2}([.,]\d{1,2})?$/.test(raw)) return Number(raw.replace(',', '.'));
  return null;
}

// Two decimal places is the finest granularity anyone bills at, and rounding
// once on the way in keeps every later sum exact.
const round2 = (n) => Math.round(n * 100) / 100;

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/**
 * Money is summed in whole cents and converted back once at the end. Adding
 * 0.1 + 0.2 in floats gives 0.30000000000000004, and across a few hundred rows
 * that drift shows up as an invoice total that is off by a cent.
 */
const cents = (n) => Math.round(n * 100);
const fromCents = (c) => c / 100;
const sumMoney = (values) => fromCents(values.reduce((acc, v) => acc + cents(v), 0));

/**
 * Returns null when the field is absent or blank, so "no rate" stays distinct
 * from zero. Returns NaN for anything unparseable.
 *
 * Validate the shape before converting, never after stripping characters:
 * stripping first turns "abc" into "" into 0, and a typo that silently becomes
 * a zero rate bills the client nothing.
 */
function parseRate(input) {
  if (input === undefined || input === null || clean(input) === '') return null;
  // Currency symbols and thousands separators are what people actually paste.
  const raw = clean(input).replace(/[$£€,\s]/g, '');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(raw)) return NaN;
  const n = Number(raw);
  return n > 100000 ? NaN : round2(n);
}

/**
 * Resolution order is a setting, because both conventions are common and the
 * choice changes every invoice. An explicit per-entry rate always wins.
 */
async function resolveRate(employee, project) {
  const priority = (await store.getSettings()).ratePriority;
  const ordered =
    priority === 'employee'
      ? [['employee', employee?.rate], ['project', project?.rate]]
      : [['project', project?.rate], ['employee', employee?.rate]];

  for (const [source, rate] of ordered) {
    if (typeof rate === 'number' && rate > 0) return { rate, rateSource: source };
  }
  return { rate: 0, rateSource: 'none' };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
app.get('/api/settings', async (_req, res) => res.json(await store.getSettings()));

app.patch('/api/settings', requireAdmin, async (req, res) => {
  const patch = {};
  if (req.body.currency !== undefined) {
    const code = clean(req.body.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) return bad(res, 'Currency must be a three-letter code, like USD');
    patch.currency = code;
  }
  if (req.body.ratePriority !== undefined) {
    if (!['project', 'employee'].includes(req.body.ratePriority)) {
      return bad(res, 'Rate priority must be either project or employee');
    }
    patch.ratePriority = req.body.ratePriority;
  }
  res.json(await store.saveSettings(patch));
});

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------
app.get('/api/employees', async (req, res) => {
  if (isAdmin(req)) return res.json(await store.listEmployees());
  // An employee needs their own record for the entry form and nothing else -
  // not colleagues' emails, rates, or roles.
  res.json(
    store
      .listEmployees()
      .filter((e) => e.id === req.user.id)
      .map((e) => ({ id: e.id, name: e.name, active: e.active })),
  );
});

app.post('/api/employees', requireAdmin, async (req, res) => {
  const name = clean(req.body.name);
  if (!name) return bad(res, 'Name is required');

  if ((await store.listEmployees()).some((e) => e.name.toLowerCase() === name.toLowerCase())) {
    return bad(res, `${name} is already in the list`);
  }

  const rate = parseRate(req.body.rate);
  if (Number.isNaN(rate)) return bad(res, 'Rate must be a number, for example 185');

  const email = clean(req.body.email).toLowerCase();
  const role = req.body.role === 'admin' ? 'admin' : 'employee';
  const password = String(req.body.password ?? '');

  // An account without an email cannot sign in; that is allowed, for people you
  // only track hours for. But a password without an email is a dead end.
  if (password && !email) return bad(res, 'An email address is needed to sign in');
  if (password && password.length < 8) return bad(res, 'Password must be at least 8 characters');
  if (email && (await store.listEmployees()).some((e) => e.email.toLowerCase() === email)) {
    return bad(res, `${email} is already used by another account`);
  }

  const created = await store.insertEmployee({
    name,
    email,
    title: clean(req.body.title),
    rate,
    role,
    passwordHash: password ? await hashPassword(password) : null,
  });

  trail(req, 'employee.create', 'employee', created.id, `Added ${name}`, { role, canSignIn: Boolean(password) });
  res.status(201).json(created);
});

/** Set or reset someone's password. Signs their other sessions out. */
app.post('/api/employees/:id/password', requireAdmin, async (req, res) => {
  const target = await store.findEmployee(req.params.id);
  if (!target) return res.status(404).json({ error: 'Employee not found' });

  const password = String(req.body?.password ?? '');
  if (password.length < 8) return bad(res, 'Password must be at least 8 characters');
  if (!target.email) return bad(res, 'Give them an email address first, so they can sign in');

  await store.setPassword(target.id, await hashPassword(password));
  // Changing a password must end existing sessions, otherwise a compromised
  // one survives the reset that was meant to close it.
  await store.deleteSessionsForUser(target.id);
  trail(req, 'employee.password', 'employee', target.id, `Set the password for ${target.name}`);
  res.json({ ok: true });
});

app.patch('/api/employees/:id', requireAdmin, async (req, res) => {
  const patch = {};
  if (req.body.name !== undefined) patch.name = clean(req.body.name);
  if (req.body.email !== undefined) patch.email = clean(req.body.email);
  if (req.body.title !== undefined) patch.title = clean(req.body.title);
  if (req.body.active !== undefined) patch.active = Boolean(req.body.active);
  if (req.body.rate !== undefined) {
    const rate = parseRate(req.body.rate);
    if (Number.isNaN(rate)) return bad(res, 'Rate must be a number, for example 185');
    patch.rate = rate;
  }
  if (patch.name === '') return bad(res, 'Name is required');

  const before = await store.findEmployee(req.params.id);
  if (!before) return res.status(404).json({ error: 'Employee not found' });

  if (req.body.role !== undefined) {
    patch.role = req.body.role === 'admin' ? 'admin' : 'employee';
  }
  // Removing the last administrator would lock everyone out of the settings,
  // the employee list and the audit trail, with no way back in through the UI.
  const losingAdmin =
    before.role === 'admin' && ((patch.role && patch.role !== 'admin') || patch.active === false);
  if (losingAdmin && await store.countAdmins() <= 1) {
    return bad(res, 'This is the only administrator. Promote someone else first.');
  }

  const row = await store.updateEmployee(req.params.id, patch);
  if (patch.active === false) await store.deleteSessionsForUser(row.id);
  trail(req, 'employee.update', 'employee', row.id, `Updated ${row.name}`, { changed: Object.keys(patch) });
  res.json(row);
});

app.delete('/api/employees/:id', requireAdmin, async (req, res) => {
  // Deleting someone with logged hours would orphan those rows and silently
  // change past totals. Deactivating hides them from the pickers instead.
  const used = await store.countEntriesForEmployee(req.params.id);
  if (used > 0) {
    return bad(
      res,
      `That person has ${used} time ${used === 1 ? 'entry' : 'entries'}. Set them inactive instead of deleting.`,
    );
  }
  const target = await store.findEmployee(req.params.id);
  if (!target) return res.status(404).json({ error: 'Employee not found' });
  if (target.id === req.user.id) return bad(res, 'You cannot delete your own account');

  await store.deleteEmployee(target.id);
  trail(req, 'employee.delete', 'employee', target.id, `Deleted ${target.name}`);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
app.get('/api/projects', async (req, res) => {
  if (isAdmin(req)) return res.json(await store.listProjects());
  // Employees see only what they are assigned to, and never the rate: what an
  // hour is billed at is commercial information.
  res.json((await store.listProjectsForEmployee(req.user.id)).map(({ rate, ...rest }) => rest));
});

app.post('/api/projects', requireAdmin, async (req, res) => {
  const name = clean(req.body.name);
  const code = clean(req.body.code).toUpperCase();
  if (!name) return bad(res, 'Project name is required');
  if (code && (await store.listProjects()).some((p) => p.code === code)) {
    return bad(res, `Code ${code} is already used by another project`);
  }

  const rate = parseRate(req.body.rate);
  if (Number.isNaN(rate)) return bad(res, 'Rate must be a number, for example 225');

  const created = await store.insertProject({ name, code, client: clean(req.body.client), rate });

  // Assign at creation, so a new project is immediately chargeable.
  const assignees = Array.isArray(req.body.employeeIds) ? req.body.employeeIds : [];
  if (assignees.length) await store.setAssignments(created.id, assignees);

  trail(req, 'project.create', 'project', created.id, `Added ${name}`, { assigned: assignees.length });
  res.status(201).json(created);
});

// --- assignments ------------------------------------------------------------
app.get('/api/projects/:id/assignments', requireAdmin, async (req, res) => {
  if (!await store.findProject(req.params.id)) return res.status(404).json({ error: 'Project not found' });
  res.json(await store.listAssignments(req.params.id));
});

app.put('/api/projects/:id/assignments', requireAdmin, async (req, res) => {
  const project = await store.findProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const ids = Array.isArray(req.body?.employeeIds) ? req.body.employeeIds : [];
  const known = new Set((await store.listEmployees()).map((e) => e.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) return bad(res, 'One of those people no longer exists');

  // Anyone already booked to this project keeps their hours; unassigning only
  // stops new entries.
  const result = await store.setAssignments(project.id, ids);
  trail(req, 'project.assign', 'project', project.id, `Set the team on ${project.name}`, { count: ids.length });
  res.json(result);
});

app.patch('/api/projects/:id', requireAdmin, async (req, res) => {
  const patch = {};
  if (req.body.name !== undefined) patch.name = clean(req.body.name);
  if (req.body.code !== undefined) patch.code = clean(req.body.code).toUpperCase();
  if (req.body.client !== undefined) patch.client = clean(req.body.client);
  if (req.body.active !== undefined) patch.active = Boolean(req.body.active);
  if (req.body.rate !== undefined) {
    const rate = parseRate(req.body.rate);
    if (Number.isNaN(rate)) return bad(res, 'Rate must be a number, for example 225');
    patch.rate = rate;
  }
  if (patch.name === '') return bad(res, 'Project name is required');

  const row = await store.updateProject(req.params.id, patch);
  if (!row) return res.status(404).json({ error: 'Project not found' });
  trail(req, 'project.update', 'project', row.id, `Updated ${row.name}`, { changed: Object.keys(patch) });
  res.json(row);
});

app.delete('/api/projects/:id', requireAdmin, async (req, res) => {
  const used = await store.countEntriesForProject(req.params.id);
  if (used > 0) {
    return bad(
      res,
      `That project has ${used} time ${used === 1 ? 'entry' : 'entries'}. Set it inactive instead of deleting.`,
    );
  }
  const target = await store.findProject(req.params.id);
  if (!target) return res.status(404).json({ error: 'Project not found' });
  await store.deleteProject(target.id);
  trail(req, 'project.delete', 'project', target.id, `Deleted ${target.name}`);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Time entries
// ---------------------------------------------------------------------------
/** Employees see only their own hours, whatever they ask for. */
function scopedQuery(req) {
  return isAdmin(req) ? req.query : { ...req.query, employeeId: req.user.id };
}

app.get('/api/entries', async (req, res) => {
  const query = scopedQuery(req);
  const entries = await store.listEntries(query);
  const totals = await store.totals(query);

  if (isAdmin(req)) {
    return res.json({ entries, ...totals, currency: (await store.getSettings()).currency });
  }
  // Strip money from the employee view. Removed here rather than hidden in the
  // UI, because data that is never sent cannot leak through a console or a log.
  res.json({
    entries: entries.map(({ rate, amount, amountCents, rateSource, ...rest }) => rest),
    totalHours: totals.totalHours,
    billableHours: totals.billableHours,
    currency: (await store.getSettings()).currency,
  });
});

async function readEntry(body, res, req, existing = null) {
  const date = clean(body.date);
  if (!isDate(date)) return bad(res, 'Pick a valid date');

  // An employee always logs as themselves, whatever the request says. An admin
  // may log on anyone's behalf, which the audit trail records.
  const employeeId = isAdmin(req) ? body.employeeId : req.user.id;

  if (!await store.findEmployee(employeeId)) return bad(res, 'Pick an employee');
  if (!await store.findProject(body.projectId)) return bad(res, 'Pick a project');

  if (!isAdmin(req) && !await store.isAssigned(body.projectId, req.user.id)) {
    return bad(res, 'You are not assigned to that project. Ask an administrator to add you.');
  }

  const hours = parseHours(body.hours);
  if (hours === null) return bad(res, 'Hours must look like 1.5, 1:30 or 1h30m');
  if (hours <= 0) return bad(res, 'Hours must be more than zero');
  if (hours > 24) return bad(res, 'A single entry cannot be more than 24 hours');

  const employee = await store.findEmployee(employeeId);
  const project = await store.findProject(body.projectId);

  // Only an admin may set a rate directly; an employee's entry always takes the
  // rate card, so nobody can quietly reprice their own work.
  const override = isAdmin(req) ? parseRate(body.rate) : null;
  if (Number.isNaN(override)) return bad(res, 'Rate must be a number, for example 185');

  // The rate is frozen onto the entry. Recomputing it on read would mean a rate
  // change next month silently rewrites what you already invoiced last month.
  let resolved;
  if (override !== null) {
    resolved = { rate: override, rateSource: 'override' };
  } else if (
    existing?.rateSource === 'override' &&
    existing.projectId === body.projectId &&
    existing.employeeId === employeeId
  ) {
    // An employee correcting their hours must not silently undo a rate an
    // administrator set by hand. Moving the entry to another project or person
    // does drop it, because the override no longer applies to that work.
    resolved = { rate: existing.rate, rateSource: existing.rateSource };
  } else {
    resolved = await resolveRate(employee, project);
  }

  return {
    date,
    employeeId,
    projectId: body.projectId,
    hours: round2(hours),
    notes: clean(body.notes),
    billable: body.billable === undefined ? true : Boolean(body.billable),
    ...resolved,
  };
}

/** Lets the form show the rate that would apply before anything is saved. */
app.get('/api/resolve-rate', requireAdmin, async (req, res) => {
  const employee = await store.findEmployee(req.query.employeeId);
  const project = await store.findProject(req.query.projectId);
  res.json({ ...(await resolveRate(employee, project)), currency: (await store.getSettings()).currency });
});

app.post('/api/entries', async (req, res) => {
  const entry = await readEntry(req.body, res, req);
  if (!entry) return;

  const saved = await store.insertEntry(entry);
  const onBehalf = saved.employeeId !== req.user.id;
  trail(
    req, 'entry.create', 'entry', saved.id,
    onBehalf
      ? `Logged ${saved.hours}h for ${saved.employeeName} on ${saved.projectName}`
      : `Logged ${saved.hours}h on ${saved.projectName}`,
    { date: saved.date, hours: saved.hours, onBehalfOf: onBehalf ? saved.employeeName : null },
  );
  res.status(201).json(saved);
});

app.patch('/api/entries/:id', async (req, res) => {
  const existing = await store.findEntry(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Entry not found' });
  if (!isAdmin(req) && existing.employeeId !== req.user.id) {
    return res.status(403).json({ error: 'You can only change your own entries' });
  }

  const entry = await readEntry(req.body, res, req, existing);
  if (!entry) return;

  const saved = await store.updateEntry(req.params.id, entry);
  trail(req, 'entry.update', 'entry', saved.id, `Changed ${saved.employeeName}'s entry on ${saved.date}`, {
    before: { hours: existing.hours, date: existing.date, project: existing.projectName },
    after: { hours: saved.hours, date: saved.date, project: saved.projectName },
  });
  res.json(saved);
});

app.delete('/api/entries/:id', async (req, res) => {
  const existing = await store.findEntry(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Entry not found' });
  if (!isAdmin(req) && existing.employeeId !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete your own entries' });
  }

  await store.deleteEntry(existing.id);
  trail(
    req, 'entry.delete', 'entry', existing.id,
    `Deleted ${existing.employeeName}'s ${existing.hours}h on ${existing.date}`,
    { project: existing.projectName, hours: existing.hours },
  );
  res.status(204).end();
});

// --- audit trail ------------------------------------------------------------
app.get('/api/audit', requireAdmin, async (req, res) => {
  res.json(await store.listAudit({ ...req.query, limit: Number(req.query.limit) || 200 }));
});

// ---------------------------------------------------------------------------
// Spreadsheet export — the point of the whole app
// ---------------------------------------------------------------------------
const BRAND = 'FF1B59A7';
const BRAND_PALE = 'FFEAF2FC';

app.get('/api/export.xlsx', async (req, res) => {
  const rows = await store.listEntries(scopedQuery(req));
  const { currency } = await store.getSettings();
  // Currency symbols vary by locale and break in other spreadsheet apps, so the
  // code goes in the header and the cells stay plain numbers you can sum.
  const MONEY = '#,##0.00';

  const wb = new ExcelJS.Workbook();
  wb.creator = 'DynamicsTeck Timesheet';
  wb.created = new Date();

  // --- Sheet 1: every entry -------------------------------------------------
  const sheet = wb.addWorksheet('Time entries', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Employee', key: 'employeeName', width: 24 },
    { header: 'Client', key: 'client', width: 22 },
    { header: 'Project code', key: 'projectCode', width: 14 },
    { header: 'Project', key: 'projectName', width: 30 },
    { header: 'Hours', key: 'hours', width: 9 },
    { header: `Rate (${currency})`, key: 'rate', width: 12 },
    { header: 'Rate from', key: 'rateSource', width: 11 },
    { header: 'Billable', key: 'billableText', width: 10 },
    { header: `Amount (${currency})`, key: 'amount', width: 14 },
    { header: 'Notes', key: 'notes', width: 44 },
  ];

  rows.forEach((r) => sheet.addRow({ ...r, billableText: r.billable ? 'Yes' : 'No' }));

  styleHeader(sheet);
  sheet.getColumn('hours').numFmt = '0.00';
  sheet.getColumn('hours').alignment = { horizontal: 'right' };
  sheet.getColumn('rate').numFmt = MONEY;
  sheet.getColumn('amount').numFmt = MONEY;
  // A real Excel filter, so the file is usable rather than just readable.
  sheet.autoFilter = { from: 'A1', to: { row: 1, column: sheet.columns.length } };

  const totalRow = sheet.addRow({
    employeeName: 'Total',
    hours: round2(rows.reduce((s, e) => s + e.hours, 0)),
    amount: sumMoney(rows.map((e) => e.amount)),
  });
  totalRow.font = { bold: true };
  totalRow.getCell('hours').numFmt = '0.00';
  totalRow.getCell('amount').numFmt = MONEY;

  // --- Sheet 2: hours per person per project --------------------------------
  const summary = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 1 }] });
  summary.columns = [
    { header: 'Employee', key: 'employee', width: 26 },
    { header: 'Project', key: 'project', width: 32 },
    { header: 'Billable hours', key: 'billable', width: 14 },
    { header: 'Non-billable', key: 'nonBillable', width: 14 },
    { header: 'Total hours', key: 'total', width: 12 },
    { header: `Amount (${currency})`, key: 'amount', width: 15 },
  ];

  const buckets = new Map();
  for (const r of rows) {
    const key = `${r.employeeName}|||${r.projectName}`;
    const b = buckets.get(key) ?? {
      employee: r.employeeName,
      project: r.projectName,
      billable: 0,
      nonBillable: 0,
      amountCents: 0,
    };
    if (r.billable) b.billable += r.hours;
    else b.nonBillable += r.hours;
    b.amountCents += cents(r.amount);
    buckets.set(key, b);
  }

  [...buckets.values()]
    .sort((a, b) => a.employee.localeCompare(b.employee) || a.project.localeCompare(b.project))
    .forEach((b) =>
      summary.addRow({
        employee: b.employee,
        project: b.project,
        billable: round2(b.billable),
        nonBillable: round2(b.nonBillable),
        total: round2(b.billable + b.nonBillable),
        amount: fromCents(b.amountCents),
      }),
    );

  const summaryTotal = summary.addRow({
    employee: 'Total',
    billable: round2(rows.filter((e) => e.billable).reduce((s, e) => s + e.hours, 0)),
    nonBillable: round2(rows.filter((e) => !e.billable).reduce((s, e) => s + e.hours, 0)),
    total: round2(rows.reduce((s, e) => s + e.hours, 0)),
    amount: sumMoney(rows.map((e) => e.amount)),
  });
  summaryTotal.font = { bold: true };

  styleHeader(summary);
  ['billable', 'nonBillable', 'total'].forEach((k) => {
    summary.getColumn(k).numFmt = '0.00';
    summary.getColumn(k).alignment = { horizontal: 'right' };
  });
  summary.getColumn('amount').numFmt = MONEY;
  summary.getColumn('amount').alignment = { horizontal: 'right' };

  // --- Sheet 3: current rate card ------------------------------------------
  const rateCard = wb.addWorksheet('Rate card');
  rateCard.columns = [
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Name', key: 'name', width: 34 },
    { header: 'Detail', key: 'detail', width: 26 },
    { header: `Rate (${currency})`, key: 'rate', width: 14 },
  ];
  (await store.listEmployees()).forEach((e) =>
    rateCard.addRow({ type: 'Employee', name: e.name, detail: e.title ?? '', rate: e.rate ?? null }),
  );
  (await store.listProjects()).forEach((p) =>
    rateCard.addRow({ type: 'Project', name: p.name, detail: p.client ?? '', rate: p.rate ?? null }),
  );
  styleHeader(rateCard);
  rateCard.getColumn('rate').numFmt = MONEY;
  rateCard.getCell(`A${rateCard.rowCount + 2}`).value =
    `When both are set, the ${(await store.getSettings()).ratePriority} rate is used.`;

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="timesheet-${stamp}.xlsx"`);
  trail(req, 'data.export', 'export', null, `Exported ${rows.length} entries`, { filters: req.query });
  await wb.xlsx.write(res);
  res.end();
});

function styleHeader(sheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
  header.alignment = { vertical: 'middle' };
  header.height = 20;
  sheet.eachRow((row, i) => {
    if (i > 1 && i % 2 === 0) {
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_PALE } };
      });
    }
  });
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

app.listen(PORT, async () => {
  console.log(`\n  DynamicsTeck Timesheet`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Database: ${store.describe}`);
  console.log(`  Accounts: ${await store.countAdmins()} administrator(s)`);
  const neverSignedIn = (await store.listEmployees()).filter((e) => e.role === 'admin' && !e.lastLoginAt);
  if (neverSignedIn.length) {
    console.log('  No administrator has signed in yet.');
    console.log('  Lost the password? Set ADMIN_PASSWORD in your environment and restart,');
    console.log('  or run `npm run reset-admin` where you have a terminal.');
  }
  console.log('');
});
