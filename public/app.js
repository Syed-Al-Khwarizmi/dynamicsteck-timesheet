/* DynamicsTeck Timesheet - client. No framework and no build step: the whole
   app is three lists and a form, and a toolchain would cost more than it saves. */

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

let employees = [];
let projects = [];
let me = null;
let settings = { currency: 'USD', ratePriority: 'project' };
const isAdmin = () => me?.role === 'admin';

const money = (n) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: settings.currency,
    currencyDisplay: 'narrowSymbol',
  }).format(n ?? 0);

// --- transport --------------------------------------------------------------
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  // The server explains what went wrong; show that rather than a status code.
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 3200);
}

// --- tabs -------------------------------------------------------------------
document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    ['entries', 'employees', 'projects', 'activity'].forEach((t) =>
      $(`tab-${t}`).classList.toggle('hidden', t !== btn.dataset.tab),
    );
  });
});

// --- reference data ---------------------------------------------------------
function fillSelect(select, items, { placeholder, activeOnly = false }) {
  const keep = select.value;
  const usable = activeOnly ? items.filter((i) => i.active !== false) : items;
  select.innerHTML =
    `<option value="">${placeholder}</option>` +
    usable
      .map((i) => {
        const label = i.code ? `${i.code} - ${i.name}` : i.name;
        return `<option value="${i.id}">${esc(label)}</option>`;
      })
      .join('');
  if (usable.some((i) => i.id === keep)) select.value = keep;
}

async function loadSettings() {
  settings = await api('/settings');
  delete settings.sessionSecret;
  $('set-currency').value = settings.currency;
  $('set-priority').value = settings.ratePriority;
}

async function saveSettings(patch) {
  try {
    settings = await api('/settings', { method: 'PATCH', body: patch });
    $('set-currency').value = settings.currency;
    $('set-priority').value = settings.ratePriority;
    updateRateHint();
    await loadReferenceData();
    await loadEntries();
    toast('Settings saved');
  } catch (err) {
    toast(err.message, true);
    await loadSettings();
  }
}

$('set-currency').addEventListener('change', (e) => saveSettings({ currency: e.target.value }));
$('set-priority').addEventListener('change', (e) => saveSettings({ ratePriority: e.target.value }));

/**
 * Shows the rate that will be applied before anything is saved, resolved on the
 * client from data already loaded - no round trip while someone is typing.
 */
function updateRateHint() {
  const hint = $('rate-hint');
  const emp = employees.find((e) => e.id === $('entry-employee').value);
  const proj = projects.find((p) => p.id === $('entry-project').value);
  if (!emp || !proj) {
    hint.textContent = '';
    $('entry-rate').placeholder = 'auto';
    return;
  }

  const ordered =
    settings.ratePriority === 'employee'
      ? [['employee rate', emp.rate], ['project rate', proj.rate]]
      : [['project rate', proj.rate], ['employee rate', emp.rate]];
  const hit = ordered.find(([, r]) => typeof r === 'number' && r > 0);

  if (hit) {
    $('entry-rate').placeholder = String(hit[1]);
    hint.innerHTML = ` Rate will be <strong>${money(hit[1])}</strong> from the ${hit[0]}. Type a rate to override it.`;
  } else {
    $('entry-rate').placeholder = '0';
    hint.innerHTML = ` <strong style="color:#b45309">No rate set</strong> for this employee or project.`;
  }
}

['entry-employee', 'entry-project'].forEach((id) =>
  document.addEventListener('change', (e) => {
    if (e.target.id === id) updateRateHint();
  }),
);

async function loadReferenceData() {
  [employees, projects] = await Promise.all([api('/employees'), api('/projects')]);

  fillSelect($('entry-employee'), employees, { placeholder: 'Choose...', activeOnly: true });
  fillSelect($('entry-project'), projects, { placeholder: 'Choose...', activeOnly: true });
  fillSelect($('filter-employee'), employees, { placeholder: 'Everyone' });
  fillSelect($('filter-project'), projects, { placeholder: 'All projects' });

  // An employee has no picker, so the form posts as them implicitly; the server
  // enforces it regardless of what the client sends.
  if (!isAdmin()) $('entry-employee').value = me?.id ?? '';

  renderEmployees();
  renderProjects();
  updateRateHint();
  void loadAssignmentCounts();
}

// --- employees --------------------------------------------------------------
function renderEmployees() {
  $('employees-empty').classList.toggle('hidden', employees.length > 0);
  $('employees-body').innerHTML = employees
    .map(
      (e) => `
    <tr>
      <td data-label="Name"><strong>${esc(e.name)}</strong></td>
      <td class="muted" data-label="Job title">${esc(e.title) || '-'}</td>
      <td class="muted" data-label="Email">${esc(e.email) || '-'}</td>
      <td data-label="Role"><span class="pill ${e.role === 'admin' ? 'admin' : 'no'}">${e.role === 'admin' ? 'Admin' : 'Employee'}</span></td>
      <td class="right num" data-label="Rate">${e.rate ? money(e.rate) : '<span class="muted">-</span>'}</td>
      <td data-label="Can sign in">${
        e.hasPassword
          ? `<span class="pill yes">Yes</span>`
          : '<span class="pill no">No</span>'
      }</td>
      <td data-label="Status"><span class="pill ${e.active === false ? 'off' : 'yes'}">${
        e.active === false ? 'Inactive' : 'Active'
      }</span></td>
      <td class="right actions">
        <button class="link" data-pw-emp="${e.id}" data-name="${esc(e.name)}">Password</button>
        <button class="link" data-role-emp="${e.id}" data-role="${e.role}">
          ${e.role === 'admin' ? 'Make employee' : 'Make admin'}
        </button>
        <button class="link" data-toggle-emp="${e.id}" data-active="${e.active !== false}">
          ${e.active === false ? 'Reactivate' : 'Deactivate'}
        </button>
        <button class="link" data-del-emp="${e.id}">Delete</button>
      </td>
    </tr>`,
    )
    .join('');
}

$('employee-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api('/employees', {
      method: 'POST',
      body: {
        name: $('emp-name').value,
        title: $('emp-title').value,
        email: $('emp-email').value,
        rate: $('emp-rate').value,
        role: $('emp-role').value,
        password: $('emp-password').value,
      },
    });
    ev.target.reset();
    await loadReferenceData();
    toast('Employee added');
  } catch (err) {
    toast(err.message, true);
  }
});

// --- projects ---------------------------------------------------------------
let assignmentCounts = {};

/** Assignment counts for the Team column, fetched once per project list load. */
async function loadAssignmentCounts() {
  if (!isAdmin()) return;
  const pairs = await Promise.all(
    projects.map(async (p) => [p.id, (await api(`/projects/${p.id}/assignments`)).length]),
  );
  assignmentCounts = Object.fromEntries(pairs);
  renderProjects();
}

/** Prompt-free assignment editor: a checkbox list under the project form. */
async function openAssign(projectId, name) {
  const current = new Set(await api(`/projects/${projectId}/assignments`));
  const panel = $('assign-panel');
  panel.querySelector('label').textContent = `Who can log time to ${name}`;
  $('assign-list').innerHTML = employees
    .filter((e) => e.active !== false)
    .map(
      (e) => `<label><input type="checkbox" value="${e.id}" ${current.has(e.id) ? 'checked' : ''}> ${esc(e.name)}</label>`,
    )
    .join('');
  $('assign-list').dataset.projectId = projectId;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('assign-list').addEventListener('change', async () => {
  const projectId = $('assign-list').dataset.projectId;
  if (!projectId) return;
  const employeeIds = [...$('assign-list').querySelectorAll('input:checked')].map((i) => i.value);
  try {
    await api(`/projects/${projectId}/assignments`, { method: 'PUT', body: { employeeIds } });
    await loadAssignmentCounts();
    await loadAudit();
    toast('Team updated');
  } catch (err) {
    toast(err.message, true);
  }
});

function renderProjects() {
  $('projects-empty').classList.toggle('hidden', projects.length > 0);
  $('projects-body').innerHTML = projects
    .map(
      (p) => `
    <tr>
      <td class="num" data-label="Code">${esc(p.code) || '-'}</td>
      <td data-label="Project"><strong>${esc(p.name)}</strong></td>
      <td class="muted" data-label="Client">${esc(p.client) || '-'}</td>
      <td class="right num" data-label="Rate">${p.rate ? money(p.rate) : '<span class="muted">-</span>'}</td>
      <td class="num muted" data-label="Team">${assignmentCounts[p.id] ?? 0}</td>
      <td data-label="Status"><span class="pill ${p.active === false ? 'off' : 'yes'}">${
        p.active === false ? 'Inactive' : 'Active'
      }</span></td>
      <td class="right actions">
        <button class="link" data-assign-proj="${p.id}" data-name="${esc(p.name)}">Team</button>
        <button class="link" data-toggle-proj="${p.id}" data-active="${p.active !== false}">
          ${p.active === false ? 'Reactivate' : 'Deactivate'}
        </button>
        <button class="link" data-del-proj="${p.id}">Delete</button>
      </td>
    </tr>`,
    )
    .join('');
}

$('project-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api('/projects', {
      method: 'POST',
      body: {
        code: $('proj-code').value,
        name: $('proj-name').value,
        client: $('proj-client').value,
        rate: $('proj-rate').value,
      },
    });
    ev.target.reset();
    await loadReferenceData();
    toast('Project added');
  } catch (err) {
    toast(err.message, true);
  }
});

// One delegated listener rather than rebinding buttons on every render.
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button');
  if (!t) return;

  try {
    if (t.dataset.delEmp) {
      await api(`/employees/${t.dataset.delEmp}`, { method: 'DELETE' });
      await loadReferenceData();
      toast('Employee removed');
    } else if (t.dataset.toggleEmp) {
      await api(`/employees/${t.dataset.toggleEmp}`, {
        method: 'PATCH',
        body: { active: t.dataset.active !== 'true' },
      });
      await loadReferenceData();
    } else if (t.dataset.delProj) {
      await api(`/projects/${t.dataset.delProj}`, { method: 'DELETE' });
      await loadReferenceData();
      toast('Project removed');
    } else if (t.dataset.toggleProj) {
      await api(`/projects/${t.dataset.toggleProj}`, {
        method: 'PATCH',
        body: { active: t.dataset.active !== 'true' },
      });
      await loadReferenceData();
    } else if (t.dataset.delEntry) {
      await api(`/entries/${t.dataset.delEntry}`, { method: 'DELETE' });
      await loadEntries();
      toast('Entry deleted');
    } else if (t.dataset.editEntry) {
      startEdit(t.dataset.editEntry);
    } else if (t.dataset.pwEmp) {
      const password = prompt(`New password for ${t.dataset.name} (at least 8 characters):`);
      if (!password) return;
      await api(`/employees/${t.dataset.pwEmp}/password`, { method: 'POST', body: { password } });
      await loadReferenceData();
      await loadAudit();
      toast('Password set. Their other sessions were signed out.');
    } else if (t.dataset.roleEmp) {
      await api(`/employees/${t.dataset.roleEmp}`, {
        method: 'PATCH',
        body: { role: t.dataset.role === 'admin' ? 'employee' : 'admin' },
      });
      await loadReferenceData();
      await loadAudit();
      toast('Role updated');
    } else if (t.dataset.assignProj) {
      await openAssign(t.dataset.assignProj, t.dataset.name);
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// --- entries ----------------------------------------------------------------
let currentEntries = [];

function filterQuery() {
  const params = new URLSearchParams();
  if ($('filter-from').value) params.set('from', $('filter-from').value);
  if ($('filter-to').value) params.set('to', $('filter-to').value);
  if ($('filter-employee').value) params.set('employeeId', $('filter-employee').value);
  if ($('filter-project').value) params.set('projectId', $('filter-project').value);
  return params.toString();
}

async function loadEntries() {
  const q = filterQuery();
  const { entries, totalHours, billableHours, totalAmount, unratedBillable } = await api(
    `/entries${q ? `?${q}` : ''}`,
  );
  currentEntries = entries;

  $('stat-count').textContent = entries.length;
  $('stat-total').textContent = totalHours.toFixed(2);
  $('stat-billable').textContent = billableHours.toFixed(2);
  if (isAdmin()) $('stat-amount').textContent = money(totalAmount ?? 0);

  // Billable hours with no rate bill nothing. Say so rather than let the total
  // quietly understate what is owed.
  const warn = $('unrated-warning');
  warn.classList.toggle('hidden', !isAdmin() || !unratedBillable);
  if (unratedBillable > 0) {
    warn.textContent =
      `${unratedBillable} billable ${unratedBillable === 1 ? 'entry has' : 'entries have'} no rate, ` +
      `so ${unratedBillable === 1 ? 'it adds' : 'they add'} nothing to the amount. ` +
      `Set a rate on the employee or the project, then edit the ${unratedBillable === 1 ? 'entry' : 'entries'}.`;
  }

  $('entries-empty').classList.toggle('hidden', entries.length > 0);
  $('entries-body').innerHTML = entries
    .map(
      (e) => `
    <tr>
      <td class="num" data-label="Date">${esc(e.date)}</td>
      <td data-label="Employee">${esc(e.employeeName)}</td>
      <td data-label="Project">${e.projectCode ? `<span class="num muted">${esc(e.projectCode)}</span> ` : ''}${esc(
        e.projectName,
      )}</td>
      <td class="right num" data-label="Hours"><strong>${e.hours.toFixed(2)}</strong></td>
      ${
        isAdmin()
          ? `<td class="right num" data-label="Rate">${
              e.rate
                ? `${money(e.rate)}<br><span class="src">${esc(e.rateSource ?? '')}</span>`
                : '<span class="muted">-</span>'
            }</td>
             <td class="right num" data-label="Amount">${e.billable ? money(e.amount) : '<span class="muted">-</span>'}</td>`
          : ''
      }
      <td data-label="Billable"><span class="pill ${e.billable ? 'yes' : 'no'}">${e.billable ? 'Yes' : 'No'}</span></td>
      <td class="muted" data-label="Notes">${esc(e.notes) || '-'}</td>
      <td class="right actions">
        <button class="link" data-edit-entry="${e.id}">Edit</button>
        <button class="link" data-del-entry="${e.id}">Delete</button>
      </td>
    </tr>`,
    )
    .join('');
}

function startEdit(id) {
  const entry = currentEntries.find((e) => e.id === id);
  if (!entry) return;
  $('entry-id').value = entry.id;
  $('entry-date').value = entry.date;
  $('entry-employee').value = entry.employeeId;
  $('entry-project').value = entry.projectId;
  $('entry-hours').value = entry.hours;
  $('entry-rate').value = entry.rate || '';
  $('entry-notes').value = entry.notes ?? '';
  $('entry-billable').checked = entry.billable;
  $('entry-submit').textContent = 'Save changes';
  $('entry-cancel').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetEntryForm() {
  $('entry-form').reset();
  $('entry-id').value = '';
  $('entry-date').value = new Date().toISOString().slice(0, 10);
  $('entry-billable').checked = true;
  $('entry-submit').textContent = 'Add entry';
  $('entry-cancel').classList.add('hidden');
  updateRateHint();
}

$('entry-cancel').addEventListener('click', resetEntryForm);

$('entry-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const id = $('entry-id').value;
  const body = {
    date: $('entry-date').value,
    employeeId: $('entry-employee').value,
    projectId: $('entry-project').value,
    hours: $('entry-hours').value,
    rate: $('entry-rate').value,
    notes: $('entry-notes').value,
    billable: $('entry-billable').checked,
  };

  try {
    await api(id ? `/entries/${id}` : '/entries', { method: id ? 'PATCH' : 'POST', body });
    const date = body.date;
    resetEntryForm();
    // Keep the date: people log several entries for the same day in a row.
    $('entry-date').value = date;
    await loadEntries();
    toast(id ? 'Entry updated' : 'Entry added');
  } catch (err) {
    toast(err.message, true);
  }
});

['filter-from', 'filter-to', 'filter-employee', 'filter-project'].forEach((id) =>
  $(id).addEventListener('change', () => loadEntries().catch((e) => toast(e.message, true))),
);

$('filter-clear').addEventListener('click', () => {
  ['filter-from', 'filter-to', 'filter-employee', 'filter-project'].forEach(
    (id) => ($(id).value = ''),
  );
  loadEntries().catch((e) => toast(e.message, true));
});

$('export-btn').addEventListener('click', () => {
  const q = filterQuery();
  // A plain navigation, so the browser handles the download and the file keeps
  // the filename the server sets.
  window.location.href = `/api/export.xlsx${q ? `?${q}` : ''}`;
  toast('Building your spreadsheet...');
});

// --- sign in ----------------------------------------------------------------
function showLock(message = '') {
  $('lock').classList.remove('hidden');
  $('lock-error').textContent = message;
  ($('lock-email').value ? $('lock-password') : $('lock-email')).focus();
}

$('lock-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const button = $('lock-submit');
  button.disabled = true;
  button.textContent = 'Signing in...';
  $('lock-error').textContent = '';

  try {
    await api('/login', {
      method: 'POST',
      body: { email: $('lock-email').value, password: $('lock-password').value },
    });
    $('lock').classList.add('hidden');
    $('lock-password').value = '';
    await start();
  } catch (err) {
    // Always say something. A button that silently does nothing gives the
    // person no way to tell a wrong password from a broken server.
    $('lock-error').textContent = err.message || 'Could not reach the server.';
    $('lock-password').select();
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});

$('signout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

// --- boot -------------------------------------------------------------------
async function loadAudit() {
  if (!isAdmin()) return;
  const params = new URLSearchParams();
  if ($('audit-action').value) params.set('action', $('audit-action').value);
  if ($('audit-from').value) params.set('from', $('audit-from').value);

  const rows = await api(`/audit?${params}`);
  $('audit-empty').classList.toggle('hidden', rows.length > 0);
  $('audit-body').innerHTML = rows
    .map((r) => {
      const when = new Date(r.at);
      const detail = Object.keys(r.detail ?? {}).length
        ? `<div class="audit-detail">${esc(JSON.stringify(r.detail))}</div>`
        : '';
      return `<tr>
        <td class="num" data-label="When">${when.toLocaleDateString()} ${when.toLocaleTimeString()}</td>
        <td data-label="Who">${esc(r.actor_name)}</td>
        <td class="num muted" data-label="Action">${esc(r.action)}</td>
        <td data-label="What happened">${esc(r.summary) || '<span class="muted">-</span>'}${detail}</td>
      </tr>`;
    })
    .join('');
}

['audit-action', 'audit-from'].forEach((id) =>
  $(id).addEventListener('change', () => loadAudit().catch((e) => toast(e.message, true))),
);

async function start() {
  me = await api('/me');
  document.body.classList.toggle('is-admin', isAdmin());
  $('who-name').textContent = me.name;
  $('who-role').textContent = isAdmin() ? 'Administrator' : 'Employee';
  $('who-role').className = `pill ${isAdmin() ? 'admin' : 'no'}`;

  resetEntryForm();
  if (isAdmin()) await loadSettings();
  await loadReferenceData();
  await loadEntries();
  await loadAudit();
}

(async function init() {
  try {
    await start();
  } catch (err) {
    // A 401 at any point means no session, or one that lapsed mid-use.
    if (/sign in/i.test(err.message) || /401/.test(err.message)) return showLock();
    toast(err.message, true);
  }
})();
