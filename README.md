# DynamicsTeck Timesheet

A small timesheet tracker. Add employees, add projects, log hours, export to Excel.

No database server, no Docker, no build step, no login.

---

## Run it

```
npm install
npm start
```

Open **http://localhost:3000**.

That is the whole setup. **Node 22.5 or newer** is the only requirement - it ships the
SQLite driver this uses, so there is nothing to compile and nothing to install.

Check yours with `node -v`.

### First run

An administrator account is created automatically and its password is printed to the
console **once**:

```
   First run. An administrator account has been created:
     Email:    admin@local
     Password: 7uYVAUKV-vBj5
```

Sign in with that, then add people from the Employees tab. Change the admin password from
the same screen (the **Password** action on the row).

**Lost the password?** The banner prints only on the first run, so stop the app and run:

```
npm run reset-admin
```

That prints a new one. It also works for any account, and lets you choose the password:

```
npm run reset-admin -- you@dynamicsteck.com MyNewPassword
```

Whichever account you name is created if it does not exist, promoted to administrator,
reactivated, and has its existing sessions ended. The reset is recorded in the activity log.

Until an administrator has signed in at least once, every startup reminds you this command
exists.

To use a different port: `set PORT=4000 && npm start` on Windows, or
`PORT=4000 npm start` elsewhere.

---

## What it does

**Accounts and roles** — two roles, and the difference is enforced on the server:

| | Administrator | Employee |
|---|---|---|
| Log own hours | yes | yes |
| Log hours for someone else | yes | no |
| See other people's hours | yes | no |
| See rates and amounts | yes | no |
| Create employees and projects | yes | no |
| Assign people to projects | yes | no |
| Read the activity log | yes | no |

An employee can only charge time to projects they have been assigned to, can only edit or
delete their own entries, and never sees a rate or an amount anywhere - those fields are
removed from the response, not hidden in the page.

**Employees** — name, job title, email, rate, role, password. Deactivate anyone who has
left; they disappear from the pickers, their sessions end immediately, and their logged
hours stay intact.

**Projects** — code, name, client, rate, and the team who may charge to it. Use the
**Team** action to set who can log time. Removing someone stops new entries but keeps the
hours they already logged.

**Activity log** — every change is recorded with who did it, when, and what changed:
entries created, edited and deleted, employees and projects added and changed, project
teams reassigned, exports, and every sign in and out. When an administrator logs hours on
someone's behalf, the log says so. Nothing in the app updates or deletes those rows.

**Billing rates** — set an hourly rate on an employee, on a project, or both. When both
have one, the header setting decides which wins; the default is the project rate, since
that is what was agreed with the client. Any single entry can override it.

**Time entries** — date, employee, project, hours, rate, notes, and a billable flag. Edit
or delete any entry. Filter by date range, employee, or project.

**Export** — the Export button produces a real `.xlsx` containing whatever your filters
currently show, with two sheets:

- *Time entries* — every row with its rate, amount and where the rate came from, an
  Excel filter already applied, and a total
- *Summary* — hours and amount per employee per project, split billable and non-billable
- *Rate card* — the rates currently set on every employee and project

## Entering hours

All of these work, so nobody has to convert in their head:

| Typed | Stored |
|---|---|
| `7.5` | 7.50 |
| `1:30` | 1.50 |
| `2h15m` | 2.25 |
| `45m` | 0.75 |
| `8` | 8.00 |

Anything else is rejected with a message rather than guessed at. A misread duration
becomes a wrong invoice.

## Putting it on the internet

Free, and nothing runs on your machine. Two services: **Turso** holds the data, **Render**
runs the app. Both deploy from GitHub.

Why not Netlify: Netlify serves static files and short-lived functions, and its filesystem
is wiped between requests, so a database file cannot survive there. The same is true of every
free tier that runs your code - none of them give you a persistent disk. The database has to
live somewhere else, which is what Turso is for. Turso is libSQL, a fork of SQLite, so this
app's schema and queries run against it unchanged.

### 1. Put the code on GitHub

**With git installed:**

```
git init && git add -A && git commit -m "DynamicsTeck Timesheet"
git remote add origin https://github.com/YOUR-NAME/dynamicsteck-timesheet.git
git branch -M main && git push -u origin main
```

**Without any tools:** extract the zip with Windows Explorer, create an empty private
repository on github.com, then use **Add file - Upload files** and drag the extracted
folder's contents into the browser. GitHub keeps the folder structure.

Upload the *contents* of the folder, not the folder itself. The archive contains no
`node_modules` or `data` directory, so there is nothing to exclude - but note that the
browser uploader ignores `.gitignore`, so never drag those two in by hand later.

### 1b. Test it in the browser (optional but worth it)

On the repository page: **Code - Codespaces - Create codespace on main**. That gives you a
Linux machine with Node 22, the dependencies already installed, and the Turso CLI, none of
it on your own computer. In its terminal:

```
npm start
```

Port 3000 forwards automatically and a preview opens. The first boot prints an
administrator password - copy it before it scrolls past. Sign in, add a project and an
entry, download the export. If it works there, it will work on Render.

Stop the Codespace when you are finished. Free accounts get 120 core hours a month and a
running 2-core machine spends 2 an hour.

### 2. Create the database

Sign up at [turso.tech](https://turso.tech) (free, no card). The CLI is already installed
in the Codespace; run these in its terminal:

```
turso auth login
turso db create timesheet
turso db show timesheet --url          # -> libsql://timesheet-yourorg.turso.io
turso db tokens create timesheet       # -> a long token
```

Keep both. **Moving your existing data across:** because Turso is SQLite, upload the file
you already have rather than retyping anything:

```
turso db create timesheet --from-file data/timesheet.db
```

### 3. Deploy the app

At [render.com](https://render.com), sign in with GitHub, then **New → Web Service** and pick
your repository. Render reads `render.yaml`, so the build and start commands are already set.
Choose the **Free** plan.

Before the first deploy, add two environment variables:

| Key | Value |
|---|---|
| `TURSO_DATABASE_URL` | the `libsql://...` URL from step 2 |
| `TURSO_AUTH_TOKEN` | the token from step 2 |

Deploy. When it finishes you get an `https://your-app.onrender.com` address.

### 4. Sign in

Open the Render logs. On the very first boot the app creates an administrator and prints the
password once:

```
   Email:    admin@local
   Password: ...
```

Copy it before the log scrolls.

**If you miss it,** Render's free plan has no shell, so use the environment instead. In the
Render dashboard add:

| Key | Value |
|---|---|
| `ADMIN_PASSWORD` | a password of your choosing, 8 characters or more |
| `ADMIN_EMAIL` | optional, defaults to `admin@local` |

Redeploy. That account is created or reset on boot and its old sessions end. Sign in, then
**delete `ADMIN_PASSWORD` again** - while it is set the password resets on every restart,
and it sits in the dashboard in plain text.

### What the free tier costs you

- **It sleeps** after about fifteen minutes without traffic, so the first request each morning
  takes roughly a minute to wake. Everything after that is normal speed.
- **No shell and no one-off jobs**, which is why admin recovery goes through `ADMIN_PASSWORD`
  above rather than a command.
- **No persistent disk** - irrelevant here, because the data lives in Turso.
- 750 instance hours a month across all free services in the workspace.

Render's cheapest paid plan removes the sleeping. A scheduled ping every ten minutes also
keeps it awake, at the cost of consuming those 750 hours.

Pushing to `main` redeploys automatically. Your data is in Turso, so deploys never touch it.

### Other hosts

Koyeb works the same way - connect the repo, set the same two variables, `npm ci` and
`npm start`. Anywhere that runs Node 22 and lets you set environment variables will do.

## On a phone

The same URL works on a phone or tablet; there is no separate app to install.

Find your computer's address with `ipconfig` (look for IPv4 under your active adapter) and
open `http://THAT-ADDRESS:3000` from the phone, on the same network. Windows Firewall will
ask to allow Node the first time.

Below 900px the layout changes rather than shrinking: each table row becomes a card with its
own labels, so nothing has to be scrolled sideways. Tabs scroll horizontally, form fields go
full width, inputs render at 16px so iOS Safari does not zoom the page when you tap one, and
buttons get 40px touch targets.

On iOS you can add it to the home screen from the Share menu and it opens without browser
chrome.

## How rates are worked out

For each entry, in order:

1. A rate typed directly into the entry, if there is one
2. Otherwise the **project** rate, or the **employee** rate — whichever the header
   setting prefers
3. Otherwise nothing, and the entry contributes zero

**The rate is frozen onto the entry when you save it.** Raising a project's rate next
month will not quietly rewrite what you already invoiced last month. To reprice old work,
edit those entries.

Non-billable entries still record a rate for reference but always total zero.

If any billable entry has no rate, a banner says how many. Billable hours with no rate
bill nothing, and a total that quietly understates is worse than one that complains.

Currency is a display and labelling choice only — there is no conversion. Set it once in
the header.

---

## Where the data lives

Locally: one SQLite file at `data/timesheet.db`. Hosted: a Turso database. The same client
and the same SQL serve both, so development and production run identical code and only the
connection changes.

Set `TURSO_DATABASE_URL` (and `TURSO_AUTH_TOKEN`) to use the hosted database; leave them unset
and it uses the local file.

**Back up the local file** by copying it while the app is stopped. For the hosted database,
`turso db shell timesheet .dump > backup.sql`. To move machines, copy it
across. You can also open it with any SQLite tool - DB Browser for SQLite, or the `sqlite3`
command line - to query or repair it directly.

What the database enforces, independently of the application code:

- Hours must be between 0 and 24, rates cannot be negative
- An entry must point at an employee and a project that exist
- An employee or project with logged hours cannot be deleted
- Employee names and project codes are unique

Those are schema constraints, so a bug in the API cannot write bad data past them.

Writes are transactional and the journal is in WAL mode, so an interrupted write rolls back
rather than corrupting the file. You will see `timesheet.db-wal` and `timesheet.db-shm`
alongside it; that is normal and they are checkpointed into the main file automatically.

**Upgrading from the JSON version:** the first run imports `data/timesheet.json` and renames
it to `timesheet.json.imported`. Nothing is deleted, and the import cannot run twice.

### Why not stay with a JSON file

It rewrote the whole dataset on every keystroke, had no constraints, and could not express
"you cannot delete someone who has logged hours" anywhere except in application code that a
future change might forget. SQLite costs nothing here and fixes all three.

## Layout

```
server.js            API and spreadsheet export
src/store.js         JSON persistence with atomic writes
public/index.html    The single page
public/app.js        Client logic, no framework
public/styles.css    Colours sampled from the DynamicsTeck logo
data/timesheet.json  Your data (created on first run)
```

## Colours

Taken directly from the logo rather than approximated:

| Token | Hex | Where it comes from |
|---|---|---|
| `--brand` | `#1B59A7` | the rear diamond |
| `--brand-light` | `#5A9BE9` | the front diamond |
| `--brand-pale` | `#EAF2FC` | tint for row banding and hovers |
| `--ink` | `#1F1F1F` | the wordmark |

They live at the top of `public/styles.css`, and `#1B59A7` is also the header fill in the
exported spreadsheet.

---

## About security, honestly

Accounts control **who can get in and what they can do**. Nothing here is encrypted.

Passwords are hashed with scrypt (Node's built-in, no native build) and never stored or
logged in plain text. Sessions are random tokens stored as hashes, so a copy of the
database cannot be used to sign in. Signing out, changing a password, or deactivating
someone revokes their sessions immediately. Eight failed attempts on an account locks that
account for a minute, and a failed sign-in takes the same time whether or not the address
exists.

- **The database file is not encrypted.** Anyone with the file, or with access to the
  machine, can read every entry. Node's SQLite driver has no encryption support; that needs
  SQLCipher, which means a native build. Use disk encryption (BitLocker) instead - it is
  stronger and costs you nothing here.
- **Traffic is plain HTTP.** On `localhost` that is fine. Across a network the password and
  your data travel in the clear, so put it behind a reverse proxy with TLS, or a VPN.
- **The last administrator cannot be demoted or deactivated.** Otherwise nobody could
  reach the settings, the employee list, or the activity log again.

That is appropriate for a small internal tool on a trusted network. It is not appropriate on
the open internet, and no amount of configuration here changes that.

## Deliberately not included

Approvals, invoicing, and reporting beyond the summary sheet. The export is the reporting
surface; do the analysis in Excel.
