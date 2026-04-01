# RISE Armament — Verbal Warning Log

A mobile-friendly web app for managers to log verbal warnings via voice dictation.
Managers sign in with their RISE Microsoft 365 account and can only view the warnings they personally logged.

---

## Quick Start

### 1. Register an App in Azure Active Directory

This gives the app permission to use Microsoft 365 login.

1. Go to [portal.azure.com](https://portal.azure.com) and sign in as an admin.
2. Navigate to **Azure Active Directory → App registrations → New registration**.
3. Fill in:
   - **Name:** `RISE Verbal Warning Log`
   - **Supported account types:** *Accounts in this organizational directory only*
   - **Redirect URI:** Select **Web** and enter `http://localhost:3000/auth/callback`
     (change this to your production URL when deploying, e.g. `https://warnings.risearmament.com/auth/callback`)
4. Click **Register**.
5. Copy the **Application (client) ID** — this is your `AZURE_CLIENT_ID`.
6. Copy the **Directory (tenant) ID** — this is your `AZURE_TENANT_ID`.
7. Go to **Certificates & secrets → New client secret**.
   - Add a description (e.g. "App Secret"), set an expiry, and click **Add**.
   - Copy the **Value** immediately (you won't see it again) — this is your `AZURE_CLIENT_SECRET`.

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Open `.env` and fill in the values from the Azure registration above:

```
AZURE_CLIENT_ID=your-application-client-id
AZURE_TENANT_ID=your-directory-tenant-id
AZURE_CLIENT_SECRET=your-client-secret-value
REDIRECT_URI=http://localhost:3000/auth/callback
APP_URL=http://localhost:3000
SESSION_SECRET=some-long-random-string-here
```

### 3. Install Dependencies and Run

```bash
npm install
npm start
```

Open `http://localhost:3000` in your browser. Managers sign in with their RISE Microsoft account.

---

## Deployment

The app can be deployed to any Node.js host. The database is a single SQLite file (`warnings.db`), making it easy to back up or migrate.

### Recommended: Azure App Service

Azure App Service pairs naturally with Azure AD (no extra firewall rules needed).

1. Create an **App Service** (Node.js 20 LTS, Linux).
2. Under **Configuration → Application settings**, add each variable from `.env` as an app setting.
3. Set `REDIRECT_URI` and `APP_URL` to your App Service URL (e.g. `https://rise-warnings.azurewebsites.net`).
4. Add the production redirect URI in your Azure AD app registration under **Authentication → Redirect URIs**.
5. Deploy with:
   ```bash
   az webapp up --name rise-warnings --resource-group YOUR-RG --runtime "NODE:20-lts"
   ```

### Alternative: Any Linux Server / Docker

```bash
NODE_ENV=production node server.js
```

For production, consider running behind a reverse proxy (nginx) with HTTPS, and using a persistent volume for `warnings.db`.

---

## Features

- **Microsoft 365 SSO** — managers sign in with their existing RISE account; no separate passwords
- **Voice dictation** — tap the mic button on any phone to dictate the warning description
- **Per-manager data isolation** — each manager sees only the warnings they logged
- **SQLite database** — all warnings stored server-side; no data lives in the browser
- **Export** — share or copy all logged warnings as formatted text

## File Structure

```
verbal-warning-app/
├── server.js          — Express server, auth, and API routes
├── package.json
├── .env.example       — Environment variable template
├── README.md
└── public/
    └── index.html     — Mobile-optimized single-page frontend
```

## Database

Warnings are stored in `warnings.db` (SQLite). To back up, just copy that file.
To view or query it directly, use [DB Browser for SQLite](https://sqlitebrowser.org/) or the `sqlite3` CLI.

```sql
-- View all warnings across all managers (admin query)
SELECT employee_name, warning_date, category, logged_by_name
FROM warnings
ORDER BY id DESC;
```

---

## Notes

- The `SESSION_SECRET` should be a random string of at least 32 characters. Generate one with:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- Client secrets in Azure AD expire. Set a reminder to rotate them before expiry.
- For HTTPS in production (required for secure cookies), deploy behind a TLS-terminating proxy or use Azure App Service's built-in HTTPS.
