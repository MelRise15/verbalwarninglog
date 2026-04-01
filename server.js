/**
 * RISE Armament — Verbal Warning Log
 * Node.js / Express backend with Microsoft 365 SSO (MSAL) + SQLite
 */

require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const msal       = require('@azure/msal-node');
const Database   = require('better-sqlite3');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────
// Database
// ─────────────────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'warnings.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS warnings (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_name    TEXT    NOT NULL,
    warning_date     TEXT    NOT NULL,
    warning_time     TEXT    NOT NULL,
    category         TEXT    NOT NULL,
    description      TEXT    NOT NULL,
    logged_by_email  TEXT    NOT NULL,
    logged_by_name   TEXT    NOT NULL,
    created_at       TEXT    NOT NULL
  )
`);

// ─────────────────────────────────────────────────────────────
// MSAL — Microsoft 365 SSO
// ─────────────────────────────────────────────────────────────
const msalConfig = {
  auth: {
    clientId:     process.env.AZURE_CLIENT_ID,
    authority:    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
  },
  system: {
    loggerOptions: {
      loggerCallback(level, message) {
        if (process.env.NODE_ENV !== 'production') console.log('[MSAL]', message);
      },
      piiLoggingEnabled: false,
      logLevel: msal.LogLevel.Warning,
    }
  }
};

const cca = new msal.ConfidentialClientApplication(msalConfig);

// ─────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret:            process.env.SESSION_SECRET || 'change-this-in-production',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge:   8 * 60 * 60 * 1000  // 8 hours
  }
}));

// Auth guard — returns 401 JSON for API calls, redirects to login for page loads
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/auth/login');
}

// ─────────────────────────────────────────────────────────────
// Auth routes
// ─────────────────────────────────────────────────────────────

// Start login — redirect to Microsoft
app.get('/auth/login', async (req, res) => {
  try {
    const authUrl = await cca.getAuthCodeUrl({
      scopes:      ['openid', 'profile', 'email'],
      redirectUri: process.env.REDIRECT_URI,
    });
    res.redirect(authUrl);
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).send('Could not initiate login. Check Azure configuration.');
  }
});

// Handle Microsoft callback
app.get('/auth/callback', async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    console.error('Auth callback error:', error, error_description);
    return res.status(401).send(`Authentication error: ${error_description || error}`);
  }

  try {
    const result = await cca.acquireTokenByCode({
      code,
      scopes:      ['openid', 'profile', 'email'],
      redirectUri: process.env.REDIRECT_URI,
    });

    req.session.user = {
      email: result.account.username.toLowerCase(),
      name:  result.account.name || result.account.username,
    };

    res.redirect('/');
  } catch (err) {
    console.error('Token exchange error:', err);
    res.status(500).send('Authentication failed. Please try again.');
  }
});

// Logout
app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    const logoutUrl = `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/logout`
      + `?post_logout_redirect_uri=${encodeURIComponent(process.env.APP_URL || `http://localhost:${PORT}`)}`;
    res.redirect(logoutUrl);
  });
});

// ─────────────────────────────────────────────────────────────
// API — current user
// ─────────────────────────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.session.user);
});

// ─────────────────────────────────────────────────────────────
// API — warnings (scoped to logged-in user)
// ─────────────────────────────────────────────────────────────

// GET all warnings for the current user (optionally filter by search query)
app.get('/api/warnings', requireAuth, (req, res) => {
  const { q } = req.query;
  let rows;

  if (q && q.trim()) {
    const like = `%${q.trim()}%`;
    rows = db.prepare(`
      SELECT * FROM warnings
      WHERE logged_by_email = ?
        AND (employee_name LIKE ? OR description LIKE ? OR category LIKE ?)
      ORDER BY id DESC
    `).all(req.session.user.email, like, like, like);
  } else {
    rows = db.prepare(`
      SELECT * FROM warnings
      WHERE logged_by_email = ?
      ORDER BY id DESC
    `).all(req.session.user.email);
  }

  res.json(rows);
});

// POST — create a new warning
app.post('/api/warnings', requireAuth, (req, res) => {
  const { employeeName, date, time, category, description } = req.body;

  if (!employeeName || !employeeName.trim()) {
    return res.status(400).json({ error: 'Employee name is required.' });
  }
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'Description is required.' });
  }

  const stmt = db.prepare(`
    INSERT INTO warnings
      (employee_name, warning_date, warning_time, category, description, logged_by_email, logged_by_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    employeeName.trim(),
    date        || new Date().toISOString().split('T')[0],
    time        || new Date().toTimeString().slice(0, 5),
    category    || 'Other',
    description.trim(),
    req.session.user.email,
    req.session.user.name,
    new Date().toISOString()
  );

  res.json({ id: info.lastInsertRowid, success: true });
});

// DELETE — only the owner can delete
app.delete('/api/warnings/:id', requireAuth, (req, res) => {
  const info = db.prepare(`
    DELETE FROM warnings WHERE id = ? AND logged_by_email = ?
  `).run(Number(req.params.id), req.session.user.email);

  if (info.changes === 0) {
    return res.status(404).json({ error: 'Warning not found or access denied.' });
  }
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// Serve frontend
// ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// All unmatched routes → the SPA (requires auth for non-login pages)
app.get('*', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Verbal Warning Log running at http://localhost:${PORT}`);
  console.log(`   Login: http://localhost:${PORT}/auth/login\n`);
});
