import { randomUUID } from 'node:crypto';
import { openDriver } from './driver.js';

/**
 * Every statement is plain SQLite SQL, which libSQL accepts unchanged. That is
 * what lets the same code run against a local file in development and against
 * Turso in production.
 *
 * Money is stored as integer cents and durations as integer minutes. Floats
 * accumulate error, and this data ends up on invoices.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS employees (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL COLLATE NOCASE,
  title         TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  rate_cents    INTEGER CHECK (rate_cents IS NULL OR rate_cents >= 0),
  role          TEXT NOT NULL DEFAULT 'employee',
  password_hash TEXT,
  last_login_at TEXT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS employees_name ON employees (name COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS employees_email ON employees (email COLLATE NOCASE) WHERE email <> '';

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL,
  client     TEXT NOT NULL DEFAULT '',
  rate_cents INTEGER CHECK (rate_cents IS NULL OR rate_cents >= 0),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_code ON projects (code) WHERE code <> '';

CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL CHECK (date LIKE '____-__-__'),
  employee_id TEXT NOT NULL REFERENCES employees (id) ON DELETE RESTRICT,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  minutes     INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  rate_cents  INTEGER NOT NULL DEFAULT 0 CHECK (rate_cents >= 0),
  rate_source TEXT NOT NULL DEFAULT 'none',
  billable    INTEGER NOT NULL DEFAULT 1 CHECK (billable IN (0, 1)),
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_date ON entries (date);
CREATE INDEX IF NOT EXISTS entries_employee ON entries (employee_id);
CREATE INDEX IF NOT EXISTS entries_project ON entries (project_id);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS assignments (
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, employee_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor_id   TEXT,
  actor_name TEXT NOT NULL,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  summary    TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log (at DESC);
`;

const DEFAULT_SETTINGS = { currency: 'USD', ratePriority: 'project' };

const toMinutes = (hours) => Math.round(hours * 60);
const toHours = (minutes) => Math.round((minutes / 60) * 100) / 100;
const toCents = (amount) => (amount === null || amount === undefined ? null : Math.round(amount * 100));
const fromCents = (c) => (c === null || c === undefined ? null : Number(c) / 100);
const flag = (v) => (v ? 1 : 0);

export class Db {
  #driver;

  static async open({ file, url, authToken } = {}) {
    const db = new Db();
    db.#driver = openDriver({ file, url, authToken });
    await db.#driver.script(SCHEMA);
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await db.#driver.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    }
    return db;
  }

  get describe() {
    return this.#driver.describe;
  }

  get remote() {
    return this.#driver.remote;
  }

  async #all(sql, params = []) {
    return (await this.#driver.execute(sql, params)).rows;
  }

  async #one(sql, params = []) {
    return (await this.#all(sql, params))[0] ?? null;
  }

  async #run(sql, params = []) {
    return (await this.#driver.execute(sql, params)).rowsAffected;
  }

  async #count(sql, params = []) {
    return Number((await this.#one(sql, params))?.n ?? 0);
  }

  // --- settings ---------------------------------------------------------------
  async getSettings() {
    const rows = await this.#all('SELECT key, value FROM settings');
    return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  }

  async saveSettings(patch) {
    await this.#driver.batch(
      Object.entries(patch).map(([key, value]) => [
        'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
        [key, String(value)],
      ]),
    );
    return this.getSettings();
  }

  // --- employees --------------------------------------------------------------
  /** Never returns password_hash. findEmployeeByEmail is the single exception. */
  #employee = (r) =>
    r && {
      id: r.id,
      name: r.name,
      title: r.title,
      email: r.email,
      rate: fromCents(r.rate_cents),
      role: r.role ?? 'employee',
      hasPassword: Boolean(r.password_hash),
      lastLoginAt: r.last_login_at ?? null,
      active: Number(r.active) === 1,
      createdAt: r.created_at,
    };

  async listEmployees() {
    return (await this.#all('SELECT * FROM employees ORDER BY name COLLATE NOCASE')).map(this.#employee);
  }

  async findEmployee(id) {
    return this.#employee(await this.#one('SELECT * FROM employees WHERE id = ?', [id]));
  }

  /** Login path only. The hash it returns must never reach a response body. */
  async findEmployeeByEmail(email) {
    return this.#one('SELECT * FROM employees WHERE email = ? COLLATE NOCASE AND active = 1', [
      String(email).trim(),
    ]);
  }

  async insertEmployee({ name, title = '', email = '', rate = null, role = 'employee', passwordHash = null }) {
    const id = randomUUID();
    await this.#run(
      `INSERT INTO employees (id, name, title, email, rate_cents, role, password_hash, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [id, name, title, email, toCents(rate), role, passwordHash, new Date().toISOString()],
    );
    return this.findEmployee(id);
  }

  async updateEmployee(id, patch) {
    if (!(await this.findEmployee(id))) return null;
    const map = { name: 'name', title: 'title', email: 'email', active: 'active', rate: 'rate_cents', role: 'role' };
    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(map)) {
      if (patch[key] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(key === 'rate' ? toCents(patch.rate) : key === 'active' ? flag(patch.active) : patch[key]);
    }
    if (sets.length) await this.#run(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    return this.findEmployee(id);
  }

  async deleteEmployee(id) {
    return (await this.#run('DELETE FROM employees WHERE id = ?', [id])) > 0;
  }

  async countEntriesForEmployee(id) {
    return this.#count('SELECT COUNT(*) AS n FROM entries WHERE employee_id = ?', [id]);
  }

  async setPassword(id, passwordHash) {
    await this.#run('UPDATE employees SET password_hash = ? WHERE id = ?', [passwordHash, id]);
  }

  async countAdmins() {
    return this.#count("SELECT COUNT(*) AS n FROM employees WHERE role = 'admin' AND active = 1");
  }

  async recordLogin(id) {
    await this.#run('UPDATE employees SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), id]);
  }

  /** Names are unique, so anything creating a record unattended resolves collisions. */
  async uniqueName(preferred) {
    const taken = new Set((await this.listEmployees()).map((e) => e.name.toLowerCase()));
    if (!taken.has(preferred.toLowerCase())) return preferred;
    for (let n = 2; ; n++) {
      const candidate = `${preferred} ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  // --- projects ---------------------------------------------------------------
  #project = (r) =>
    r && {
      id: r.id,
      code: r.code,
      name: r.name,
      client: r.client,
      rate: fromCents(r.rate_cents),
      active: Number(r.active) === 1,
      createdAt: r.created_at,
    };

  async listProjects() {
    return (await this.#all('SELECT * FROM projects ORDER BY name COLLATE NOCASE')).map(this.#project);
  }

  async findProject(id) {
    return this.#project(await this.#one('SELECT * FROM projects WHERE id = ?', [id]));
  }

  async insertProject({ code = '', name, client = '', rate = null }) {
    const id = randomUUID();
    await this.#run(
      'INSERT INTO projects (id, code, name, client, rate_cents, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      [id, code, name, client, toCents(rate), new Date().toISOString()],
    );
    return this.findProject(id);
  }

  async updateProject(id, patch) {
    if (!(await this.findProject(id))) return null;
    const map = { code: 'code', name: 'name', client: 'client', active: 'active', rate: 'rate_cents' };
    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(map)) {
      if (patch[key] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(key === 'rate' ? toCents(patch.rate) : key === 'active' ? flag(patch.active) : patch[key]);
    }
    if (sets.length) await this.#run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    return this.findProject(id);
  }

  async deleteProject(id) {
    return (await this.#run('DELETE FROM projects WHERE id = ?', [id])) > 0;
  }

  async countEntriesForProject(id) {
    return this.#count('SELECT COUNT(*) AS n FROM entries WHERE project_id = ?', [id]);
  }

  // --- assignments ------------------------------------------------------------
  async listAssignments(projectId) {
    return (await this.#all('SELECT employee_id FROM assignments WHERE project_id = ?', [projectId])).map(
      (r) => r.employee_id,
    );
  }

  async listProjectsForEmployee(employeeId) {
    return (
      await this.#all(
        `SELECT p.* FROM projects p
         JOIN assignments a ON a.project_id = p.id
         WHERE a.employee_id = ? AND p.active = 1
         ORDER BY p.name COLLATE NOCASE`,
        [employeeId],
      )
    ).map(this.#project);
  }

  async isAssigned(projectId, employeeId) {
    return (
      (await this.#count('SELECT COUNT(*) AS n FROM assignments WHERE project_id = ? AND employee_id = ?', [
        projectId,
        employeeId,
      ])) > 0
    );
  }

  async setAssignments(projectId, employeeIds) {
    const now = new Date().toISOString();
    await this.#driver.batch([
      ['DELETE FROM assignments WHERE project_id = ?', [projectId]],
      ...employeeIds.map((id) => [
        'INSERT INTO assignments (project_id, employee_id, created_at) VALUES (?, ?, ?)',
        [projectId, id, now],
      ]),
    ]);
    return this.listAssignments(projectId);
  }

  // --- entries ----------------------------------------------------------------
  #entry = (r) => {
    if (!r) return null;
    const minutes = Number(r.minutes);
    const rateCents = Number(r.rate_cents);
    const billable = Number(r.billable) === 1;
    // Whole cents from integer inputs, rounded exactly once.
    const amountCents = billable ? Math.round((minutes * rateCents) / 60) : 0;
    return {
      id: r.id,
      date: r.date,
      employeeId: r.employee_id,
      projectId: r.project_id,
      hours: toHours(minutes),
      minutes,
      rate: fromCents(rateCents),
      rateSource: r.rate_source,
      billable,
      notes: r.notes,
      amount: amountCents / 100,
      amountCents,
      employeeName: r.employee_name ?? 'Unknown',
      projectName: r.project_name ?? 'Unknown',
      projectCode: r.project_code ?? '',
      client: r.client ?? '',
      createdAt: r.created_at,
    };
  };

  #entrySelect = `
    SELECT e.*, em.name AS employee_name, p.name AS project_name,
           p.code AS project_code, p.client AS client
    FROM entries e
    JOIN employees em ON em.id = e.employee_id
    JOIN projects  p  ON p.id  = e.project_id`;

  /** Filtering happens in SQL, so the table is never loaded to discard most of it. */
  async listEntries(filter = {}) {
    const where = [];
    const params = [];
    if (filter.from) (where.push('e.date >= ?'), params.push(filter.from));
    if (filter.to) (where.push('e.date <= ?'), params.push(filter.to));
    if (filter.employeeId) (where.push('e.employee_id = ?'), params.push(filter.employeeId));
    if (filter.projectId) (where.push('e.project_id = ?'), params.push(filter.projectId));

    const rows = await this.#all(
      `${this.#entrySelect}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY e.date DESC, em.name COLLATE NOCASE`,
      params,
    );
    return rows.map(this.#entry);
  }

  async findEntry(id) {
    return this.#entry(await this.#one(`${this.#entrySelect} WHERE e.id = ?`, [id]));
  }

  async insertEntry(entry) {
    const id = randomUUID();
    await this.#run(
      `INSERT INTO entries (id, date, employee_id, project_id, minutes, rate_cents, rate_source, billable, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, entry.date, entry.employeeId, entry.projectId, toMinutes(entry.hours),
        toCents(entry.rate) ?? 0, entry.rateSource, flag(entry.billable), entry.notes ?? '',
        new Date().toISOString(),
      ],
    );
    return this.findEntry(id);
  }

  async updateEntry(id, entry) {
    if (!(await this.findEntry(id))) return null;
    await this.#run(
      `UPDATE entries SET date = ?, employee_id = ?, project_id = ?, minutes = ?,
                          rate_cents = ?, rate_source = ?, billable = ?, notes = ?
       WHERE id = ?`,
      [
        entry.date, entry.employeeId, entry.projectId, toMinutes(entry.hours),
        toCents(entry.rate) ?? 0, entry.rateSource, flag(entry.billable), entry.notes ?? '', id,
      ],
    );
    return this.findEntry(id);
  }

  async deleteEntry(id) {
    return (await this.#run('DELETE FROM entries WHERE id = ?', [id])) > 0;
  }

  async totals(filter = {}) {
    const rows = await this.listEntries(filter);
    const totalMinutes = rows.reduce((s, r) => s + r.minutes, 0);
    const billableMinutes = rows.filter((r) => r.billable).reduce((s, r) => s + r.minutes, 0);
    const amountCents = rows.reduce((s, r) => s + r.amountCents, 0);
    return {
      totalHours: toHours(totalMinutes),
      billableHours: toHours(billableMinutes),
      totalAmount: amountCents / 100,
      unratedBillable: rows.filter((r) => r.billable && !r.rate).length,
    };
  }

  // --- sessions ---------------------------------------------------------------
  async createSession(tokenHash, userId, expiresAt) {
    await this.#run('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [
      tokenHash, userId, new Date().toISOString(), expiresAt,
    ]);
  }

  async findSessionUser(tokenHash) {
    return this.#employee(
      await this.#one(
        `SELECT e.* FROM sessions s
         JOIN employees e ON e.id = s.user_id
         WHERE s.id = ? AND s.expires_at > ? AND e.active = 1`,
        [tokenHash, new Date().toISOString()],
      ),
    );
  }

  async deleteSession(tokenHash) {
    await this.#run('DELETE FROM sessions WHERE id = ?', [tokenHash]);
  }

  /** Used when someone is deactivated or has their password changed. */
  async deleteSessionsForUser(userId) {
    await this.#run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }

  async purgeExpiredSessions() {
    await this.#run('DELETE FROM sessions WHERE expires_at <= ?', [new Date().toISOString()]);
  }

  // --- audit ------------------------------------------------------------------
  async audit({ actorId = null, actorName, action, entity, entityId = null, summary = '', detail = {} }) {
    await this.#run(
      `INSERT INTO audit_log (at, actor_id, actor_name, action, entity, entity_id, summary, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [new Date().toISOString(), actorId, actorName, action, entity, entityId, summary, JSON.stringify(detail)],
    );
  }

  async listAudit({ limit = 200, actorId, action, from, to } = {}) {
    const where = [];
    const params = [];
    if (actorId) (where.push('actor_id = ?'), params.push(actorId));
    if (action) (where.push('action LIKE ?'), params.push(`${action}%`));
    if (from) (where.push('at >= ?'), params.push(from));
    if (to) (where.push('at <= ?'), params.push(`${to}T23:59:59.999Z`));

    const rows = await this.#all(
      `SELECT * FROM audit_log
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY at DESC, id DESC LIMIT ?`,
      [...params, Math.min(Number(limit) || 200, 1000)],
    );
    return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail || '{}') }));
  }

  async close() {
    await this.#driver.close();
  }
}
