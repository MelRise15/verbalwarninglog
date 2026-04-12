/**
 * RISE Armament — Verbal Warning Log
 * Node.js / Express backend with Microsoft 365 SSO (MSAL) + Supabase
 * Vercel-compatible: sessions stored in Supabase PostgreSQL
 */

require('dotenv').config();
const express               = require('express');
const cookieSession         = require('cookie-session');
const msal                  = require('@azure/msal-node');
const Anthropic             = require('@anthropic-ai/sdk');
const { createClient }      = require('@supabase/supabase-js');
const path                  = require('path');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase  = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app  = express();
const PORT = process.env.PORT || 3000;

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
app.set('trust proxy', 1); // Required for Vercel — trust the HTTPS proxy (v2)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cookieSession({
  name:   'rise_session',
  keys:   [process.env.SESSION_SECRET || 'change-this-in-production'],
  maxAge: 8 * 60 * 60 * 1000,  // 8 hours
  secure: process.env.NODE_ENV === 'production',
  httpOnly: true,
  sameSite: 'lax',
}));

// ─────────────────────────────────────────────────────────────
// Admin helpers
// ─────────────────────────────────────────────────────────────
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
);
console.log('[ADMIN] ADMIN_EMAILS loaded:', [...ADMIN_EMAILS]);

function isAdmin(email) {
  return ADMIN_EMAILS.has(email.toLowerCase());
}

function requireAuth(req, res, next) {
  if (req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/auth/login');
}

function requireAdmin(req, res, next) {
  if (req.session.user && isAdmin(req.session.user.email)) return next();
  res.status(403).json({ error: 'Admin access required.' });
}

// Inject live isAdmin into every authenticated request
function injectAdminStatus(req, res, next) {
  if (req.session.user) {
    req.session.user.isAdmin = isAdmin(req.session.user.email);
  }
  next();
}
app.use(injectAdminStatus);

// ─────────────────────────────────────────────────────────────
// Auth routes
// ─────────────────────────────────────────────────────────────

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

    const email = result.account.username.toLowerCase();
    req.session.user = {
      email,
      name:    result.account.name || result.account.username,
      isAdmin: isAdmin(email),
    };

    res.redirect('/');
  } catch (err) {
    console.error('Token exchange error:', err);
    res.status(500).send('Authentication failed. Please try again.');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session = null;
  const logoutUrl = `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/logout`
    + `?post_logout_redirect_uri=${encodeURIComponent(process.env.APP_URL || `http://localhost:${PORT}`)}`;
  res.redirect(logoutUrl);
});

// ─────────────────────────────────────────────────────────────
// API — current user
// ─────────────────────────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.session.user);
});

// ─────────────────────────────────────────────────────────────
// API — punctuation cleanup via Claude
// ─────────────────────────────────────────────────────────────
app.post('/api/punctuate', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.json({ text: text || '' });

  try {
    const message = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role:    'user',
        content: `You are a transcription editor. Add proper punctuation and capitalization to this dictated text from a workplace verbal warning log. Rules:
- Do not change, add, or remove any words
- Add periods, commas, and other punctuation where naturally needed
- Capitalize the first word of each sentence and proper nouns
- Return only the corrected text, nothing else

Text to fix:
${text.trim()}`
      }]
    });

    res.json({ text: message.content[0].text.trim() });
  } catch (err) {
    console.error('Punctuation API error:', err);
    const fallback = text.trim().charAt(0).toUpperCase() + text.trim().slice(1);
    res.json({ text: fallback });
  }
});

// ─────────────────────────────────────────────────────────────
// API — warnings (scoped to logged-in user)
// ─────────────────────────────────────────────────────────────

// GET warnings for current user
app.get('/api/warnings', requireAuth, async (req, res) => {
  const { q } = req.query;
  const email = req.session.user.email;

  try {
    let query = supabase
      .from('warnings')
      .select('*')
      .eq('logged_by_email', email)
      .order('id', { ascending: false });

    if (q && q.trim()) {
      const search = q.trim();
      query = supabase
        .from('warnings')
        .select('*')
        .eq('logged_by_email', email)
        .or(`employee_name.ilike.%${search}%,description.ilike.%${search}%,category.ilike.%${search}%`)
        .order('id', { ascending: false });
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('GET /api/warnings error:', err);
    res.status(500).json({ error: 'Failed to load warnings.' });
  }
});

// POST — create a new warning
app.post('/api/warnings', requireAuth, async (req, res) => {
  const { employeeName, date, time, category, description } = req.body;

  if (!employeeName || !employeeName.trim()) {
    return res.status(400).json({ error: 'Employee name is required.' });
  }
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'Description is required.' });
  }

  try {
    const { data, error } = await supabase
      .from('warnings')
      .insert({
        employee_name:   employeeName.trim(),
        warning_date:    date     || new Date().toISOString().split('T')[0],
        warning_time:    time     || new Date().toTimeString().slice(0, 5),
        category:        category || 'Other',
        description:     description.trim(),
        logged_by_email: req.session.user.email,
        logged_by_name:  req.session.user.name,
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ id: data.id, success: true });
  } catch (err) {
    console.error('POST /api/warnings error:', err);
    res.status(500).json({ error: 'Failed to save warning.' });
  }
});

// DELETE — owner deletes their own; admin deletes any
app.delete('/api/warnings/:id', requireAuth, async (req, res) => {
  const { user } = req.session;
  const id = Number(req.params.id);

  try {
    let query = supabase.from('warnings').delete().eq('id', id);
    if (!isAdmin(user.email)) query = query.eq('logged_by_email', user.email);

    const { error, count } = await query;
    if (error) throw error;
    if (count === 0) return res.status(404).json({ error: 'Warning not found or access denied.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/warnings error:', err);
    res.status(500).json({ error: 'Failed to delete warning.' });
  }
});

// ─────────────────────────────────────────────────────────────
// API — admin: all warnings across all managers
// ─────────────────────────────────────────────────────────────

app.get('/api/admin/warnings', requireAuth, requireAdmin, async (req, res) => {
  const { q } = req.query;

  try {
    let query = supabase
      .from('warnings')
      .select('*')
      .order('id', { ascending: false });

    if (q && q.trim()) {
      const search = q.trim();
      query = supabase
        .from('warnings')
        .select('*')
        .or(`employee_name.ilike.%${search}%,description.ilike.%${search}%,category.ilike.%${search}%,logged_by_name.ilike.%${search}%`)
        .order('id', { ascending: false });
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('GET /api/admin/warnings error:', err);
    res.status(500).json({ error: 'Failed to load warnings.' });
  }
});

// ─────────────────────────────────────────────────────────────
// Serve frontend
// ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Verbal Warning Log running at http://localhost:${PORT}`);
  console.log(`   Login: http://localhost:${PORT}/auth/login\n`);
});
// cache bust Sun Apr 12 12:17:37 CDT 2026
