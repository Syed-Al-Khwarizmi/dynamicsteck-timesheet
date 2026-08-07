#!/usr/bin/env node
/**
 * Recover access when the administrator password is lost.
 *
 *   npm run reset-admin                 -> resets admin@local, prints a new password
 *   npm run reset-admin -- you@work.com -> resets that account instead
 *   npm run reset-admin -- you@work.com MyNewPassword
 *
 * Creates the account if it does not exist, promotes it to administrator,
 * reactivates it, and ends any existing sessions.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from '../src/db.js';
import { hashPassword, suggestPassword } from '../src/auth.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const store = await Db.open({
  file: join(root, 'data', 'timesheet.db'),
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const email = (process.argv[2] ?? 'admin@local').toLowerCase().trim();
const password = process.argv[3] ?? suggestPassword();

if (password.length < 8) {
  console.error('\n  Password must be at least 8 characters.\n');
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  console.error(`\n  Could not reset that account: ${err.message}\n`);
  process.exit(1);
});

const passwordHash = await hashPassword(password);
const existing = (await store.listEmployees()).find((e) => e.email.toLowerCase() === email);

// Name the account after the address rather than a fixed string, so resetting
// a second account does not collide with the first.
const localPart = email.split('@')[0] ?? 'admin';
const preferred = localPart.charAt(0).toUpperCase() + localPart.slice(1);

let account;
if (existing) {
  await store.setPassword(existing.id, passwordHash);
  account = await store.updateEmployee(existing.id, { role: 'admin', active: true });
  await store.deleteSessionsForUser(existing.id);
  console.log(`\n  Reset the password for ${account.name} and made sure they are an administrator.`);
} else {
  account = await store.insertEmployee({
    name: await store.uniqueName(preferred),
    email,
    title: 'Administrator',
    role: 'admin',
    passwordHash,
  });
  console.log('\n  Created a new administrator account.');
}

await store.audit({
  actorId: null,
  actorName: 'reset-admin script',
  action: 'employee.password',
  entity: 'employee',
  entityId: account.id,
  summary: `Password reset from the command line for ${email}`,
});

console.log('  ---------------------------------------------------------');
console.log(`    Email:    ${email}`);
console.log(`    Password: ${password}`);
console.log('  ---------------------------------------------------------');
console.log('  Sign in, then change it from the Employees tab.\n');

await store.close();
