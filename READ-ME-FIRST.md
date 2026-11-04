# LMS — deploy (for the developer)

This is the only document you need. Your job is the deploy: server settings,
build, start, confirm it is up. Everything inside the app (backups, checks,
testing) is done by us.

> **29 October: this release moves the app from Railway to AWS, database
> included.** Follow **"Moving to AWS"** directly below, not Steps 0–6
> (those are the old in-place Railway update and are kept only for
> reference). Three small database updates run on their own when the new
> backend starts: `20261026120000_department_role_home`,
> `20261027120000_vendor_shipping`, `20261028120000_upload_undone_marker`.
> Existing data is unchanged by all three. `VAULT_SECRET_KEY` must be copied
> across exactly as it is.

- App: `https://rxlms.sbs` · API: `https://api.rxlms.store`
- The database moves from Railway to AWS (Lightsail PostgreSQL) once, during a short planned
  stop (A4). The new code then updates it on start.
- Two zips, one per service, each with the code at the top level:
  **`lms-backend.zip`** (the API) and **`lms-frontend.zip`** (the website).
  This same document is in both.

---

## Moving to AWS (do this, 29 October)

The app moves from Railway to AWS: database, backend and frontend. Same web
addresses (`https://rxlms.sbs`, `https://api.rxlms.store`), same S3 bucket for
files, same email. Nothing is lost if you follow the order below; going back
is possible until you delete Railway (Step A8).

**What runs where**

| Part | On AWS | Notes |
|---|---|---|
| Database | **Already created:** Lightsail managed PostgreSQL **18.6**, instance `lms`, Mumbai (`ap-south-1`), user `dbmasteruser`, database **`dbmaster`**. Empty, SSL on. | Public mode is ON for now so the data can be copied in; switch it off (or limit it to the backend) after the move. Automated backups ON. |
| Backend | One container from `lms-backend.zip` (ECS/Fargate, App Runner or EC2 — your choice) | Listens on **3000**. Exactly **one** running copy (live updates and rate limits are held in memory). Health check: `GET /api/health`. |
| Frontend | One container from `lms-frontend.zip` | Listens on **5173**. Health check: `GET /`. |
| Load balancer | HTTPS (ACM certificates for both addresses) | **Must allow WebSockets** (live notifications) — an Application Load Balancer does; keep idle timeout at 60 s or more. |
| Files | Stay in S3 bucket `lms-rx-portal`, folder `prod-files/` | Nothing to copy. |

### A1. Database — already done

The Lightsail database exists and is empty. **Do not start the backend
against it before the data is copied in (A4).** On start the backend creates
its tables; real data copied in afterwards would then clash with them.

- Connection string for the backend (we send you the password privately):
  `postgresql://dbmasteruser:PASSWORD@ls-65a01574cf1213bf86e80ae8a922654485f2011d.c38s662q6c5l.ap-south-1.rds.amazonaws.com:5432/dbmaster?sslmode=require`
- If the password contains characters such as `< > | & ? ] !`, they must be
  percent-encoded inside the URL (e.g. `?` → `%3F`, `&` → `%26`, `|` → `%7C`,
  `<` → `%3C`, `>` → `%3E`, `]` → `%5D`, `!` → `%21`).
- The copy (A4) needs PostgreSQL **18** client tools (`pg_dump` /
  `pg_restore` 18.x) — older ones cannot restore into 18 reliably.

### A2. Backend settings

Copy **every** backend setting from Railway **exactly**, then change only what
is listed under "Change". Never retype or regenerate `VAULT_SECRET_KEY` — a
different value permanently locks every stored vault password and every
backup. There is no recovery from that.

Copy unchanged: `VAULT_SECRET_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`,
`APP_URL` (`https://rxlms.sbs`), `CORS_ORIGINS` (`https://rxlms.sbs`),
`NODE_ENV` (`production`), `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`,
`VAULT_RESET_EMAIL`, `VAULT_RESET_EMAIL_PASSWORD` (if set),
`STORAGE_PROVIDER` (`s3`), `S3_BUCKET`, `S3_REGION`, `S3_PREFIX`
(`prod-files/`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.

Change / add:

- `DATABASE_URL` → the Lightsail connection string from A1.
- `TRUST_PROXY=1` → **new, required on AWS.** Behind the load balancer every
  request otherwise looks like it comes from one address, so all users share
  one rate limit and get locked out together.

Leave `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE` unset. (Optional: instead of the
two `S3_*_KEY` values, give the backend an IAM role with access to the
`prod-files/` folder of `lms-rx-portal`; the app uses the role when the keys
are absent.) Do **not** set `THROTTLE_MULTIPLIER` or `VITE_SHOW_DEMO_LOGINS`.

### A3. Build the images

- Backend: build from the unzipped `lms-backend.zip` folder (its `Dockerfile`).
- Frontend: build from the unzipped `lms-frontend.zip` folder with
  `--build-arg VITE_API_BASE_URL=https://api.rxlms.store/api`. This value is
  baked in at build time (it also sets the page's security policy), so a
  frontend built without it cannot talk to the API.

Push both to ECR (or wherever your service pulls from). **Do not start the
backend yet.**

### A4. Move the data (the only downtime, about 15 minutes)

Tell us before you start; we warn the users.

1. **Stop the Railway backend** (scale to 0) so nobody can write while you
   copy. Leave the Railway database running.
2. Dump it:
   ```bash
   pg_dump "$RAILWAY_DATABASE_URL" -Fc -f lms-cutover-$(date +%Y%m%d-%H%M).dump
   ```
   Keep this file safe and off the servers. It is also the rollback.
3. Restore into Lightsail (database `dbmaster`, still empty — the backend must not have been started yet):
   ```bash
   pg_restore --no-owner --no-acl -d "$LIGHTSAIL_DATABASE_URL" lms-cutover-*.dump
   ```
4. Check the copy is complete — run this on **both** databases (Railway and Lightsail); the numbers
   must match exactly:
   ```bash
   psql "$DB" -Atc 'SELECT (SELECT count(*) FROM "User"), (SELECT count(*) FROM "InventoryItem"), (SELECT count(*) FROM "Indent"), (SELECT count(*) FROM "ComponentRequest"), (SELECT count(*) FROM "_prisma_migrations")'
   ```

### A5. Start on AWS

1. Start the backend (one copy). On start it applies the three database
   updates listed at the top; the log must say they were applied and
   "All migrations have been successfully applied". If it does not start, do
   not retry repeatedly — send us the last 100 lines of its log.
2. Start the frontend.
3. Before switching the addresses, check the backend through the load
   balancer's own AWS address:
   ```bash
   curl -s https://<load-balancer-address>/api/health
   ```
   Expect `"status":"ok"`, `"database":"reachable"`, `"uploads":"object-storage"`.

### A6. Switch the addresses

Point `rxlms.sbs` (frontend) and `api.rxlms.store` (backend) at the AWS load
balancer, with HTTPS certificates in place. Then:

```bash
curl -s https://api.rxlms.store/api/health
```

Same three values as above. Then tell us — we sign in and run our checks.

### A7. If something is wrong (rollback)

Point the two addresses back at Railway and start the Railway backend again.
Its database was not touched after the dump, so it is exactly as it was —
**but anything entered on AWS since the switch would not be there.** Tell us
before rolling back once people have started using AWS.

### A8. Afterwards

Keep the Railway database (stopped is fine) and the cutover dump for **at
least a week**. Delete Railway only when we confirm.

### Send us these

1. The health check output from A6.
2. The backend start-up log lines about migrations.
3. The row counts from A4 for both databases.
4. Confirmation that every setting was copied from Railway, that
   `VAULT_SECRET_KEY` was not changed, and that `TRUST_PROXY=1` was added.
5. The name of the cutover dump file and where it is stored.
6. Confirmation that the backend was first started only AFTER the data copy (A4).

---

# Old in-place Railway update (reference only — do not use)

## Step 0 — wait for our go-ahead

Before you touch anything, we take a database backup from inside the app and
the inventory team downloads their stock list. We will message you "go".

## Step 1 — add the new settings (environment variables)

**Add these to the backend's existing settings. Do not replace or retype the
existing ones.** In particular, never change `VAULT_SECRET_KEY` — a different
value permanently locks every stored password in the vault and every backup.
There is no recovery from that.

We send you the values marked "from us" privately (not in Slack).

```
APP_URL=https://rxlms.sbs
BREVO_API_KEY=<from us>
BREVO_SENDER_EMAIL=<from us>

STORAGE_PROVIDER=s3
S3_BUCKET=lms-rx-portal
S3_REGION=ap-south-1
S3_PREFIX=prod-files/
S3_ACCESS_KEY_ID=<from us>
S3_SECRET_ACCESS_KEY=<from us>
```

The names matter: the app reads `S3_…`, not `AWS_…`. If you were given the
AWS keys as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, put the same
values under the `S3_…` names above. `S3_PREFIX` is the folder production's
files go in; the bucket also holds other things, so do not leave it out.

Leave `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE` unset (AWS).
Do **not** set `TRUST_PROXY`, `THROTTLE_MULTIPLIER` or `VITE_SHOW_DEMO_LOGINS` (unless we ask).

Why these matter: without the two `BREVO_*` values password-reset emails are
never sent; without `APP_URL` they are sent with a dead `localhost` link;
without the `S3_*` values uploaded files go back to the server's disk and are
wiped on the next redeploy.

## Step 2 — one database fix before deploying (required)

Production has one duplicate item ("Mechanic C210 Soldering Tip", both copies
at stock 0). The new code adds a rule that names must be unique, and **the app
will not start while the duplicate exists.** Remove the copy that has no
history:

```bash
psql "$DATABASE_URL" -c "UPDATE \"InventoryItem\" SET \"deletedAt\" = now() WHERE id = '5541ea69-b2df-423f-b71c-7210b54b7ea8' AND \"deletedAt\" IS NULL;"
```

Then confirm nothing else is duplicated. Each of these must return **no rows**
(run the first one from the unzipped backend folder — the script is in
`lms-backend.zip` under `scripts/`):

```bash
psql "$DATABASE_URL" -f scripts/duplicate-items-report.sql
```
```bash
psql "$DATABASE_URL" -c 'SELECT lower(btrim(email)) e, count(*) FROM "User" WHERE "deletedAt" IS NULL GROUP BY 1 HAVING count(*) > 1'
```
```bash
psql "$DATABASE_URL" -c 'SELECT "serialNo", count(*) FROM "Indent" WHERE "deletedAt" IS NULL GROUP BY 1 HAVING count(*) > 1'
```
```bash
psql "$DATABASE_URL" -c 'SELECT "serialNo", count(*) FROM "ComponentRequest" WHERE "deletedAt" IS NULL GROUP BY 1 HAVING count(*) > 1'
```
```bash
psql "$DATABASE_URL" -c 'SELECT "serialNo", count(*) FROM "BomList" WHERE "deletedAt" IS NULL GROUP BY 1 HAVING count(*) > 1'
```

If any returns rows, stop and send us the output.

## Step 3 — database backup

```bash
pg_dump "$DATABASE_URL" -Fc > pre-deploy-$(date +%Y%m%d-%H%M).dump
```

Keep this file off the server. It is the rollback.

## Step 3b — copy the uploaded files off the server

The current server keeps uploaded files (receipts, photos, vendor forms) in
`/app/uploads` on the backend container's own disk, with no volume. The
redeploy wipes it. Copy the whole folder somewhere safe **before** Step 4.

If you cannot get into the running container, tell us before deploying —
do not deploy first and find out after.

## Step 4 — deploy

Replace each service's code with its zip, keeping all settings:

- **Backend service** ← contents of `lms-backend.zip`
- **Frontend service** ← contents of `lms-frontend.zip`

Then rebuild **both**. The frontend must be rebuilt **without the build
cache** — a restart alone keeps serving the old screens. Each zip has its own
`Dockerfile`; build each service from its own folder as you do today.

The frontend's `VITE_API_BASE_URL` (a build setting, today
`https://api.rxlms.store/api`) stays exactly as it is. Do not add
`VITE_SHOW_DEMO_LOGINS`.

Database updates (17 of them on a first deploy from the old version) run automatically when the backend starts. You
do not run them by hand. If one fails, the backend does not start — it does not
half-start.

Set the platform's health check to `/api/health` if it is not already.

## Step 5 — confirm it is up

```bash
curl -s https://api.rxlms.store/api/health
```

Expect `"status":"ok"`, `"database":"reachable"` and `"uploads":"object-storage"`.

## Step 6 — put the copied files into the bucket

Upload the **contents** of the folder from Step 3b into the `prod-files/`
folder of the bucket, keeping the sub-folders (`payment-receipts/…`,
`fixed-assets_…/…`), using the same keys as Step 1:

```bash
aws s3 sync ./uploads/ s3://lms-rx-portal/prod-files/
```

The app finds them there by the same names it already has on record.

---

## Send us these when done

1. The output of the health check above.
2. The backend start-up log lines about migrations (3 applied on this update; no errors).
3. Confirmation that you **added** the settings and did not change
   `VAULT_SECRET_KEY`.
4. The name of the pre-deploy backup file and where you stored it.
5. How many files were copied in Step 3b and synced in Step 6 (or that the
   folder was empty).
6. Whether `TRUST_PROXY` or `THROTTLE_MULTIPLIER` were already set on the
   server before you started (yes/no, and the value).

Then we take it from there.

## If the backend does not start

Do not retry repeatedly. Send us the last 100 lines of the backend log. The
most likely cause is Step 2 (a duplicate still present) — the log names the
index that failed. To roll back: the previous build plus the Step 3 backup.
