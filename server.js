const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── مسار تخزين البيانات ──────────────────────────────
// Railway Volume: يُوصى بضبط DATA_DIR=/data في إعدادات المشروع.
// إذا كان المسار غير قابل للكتابة (تشغيل محلي بدون Volume) نرجع إلى ./data
function resolveDataDir() {
  const candidates = [process.env.DATA_DIR, '/data', path.join(__dirname, 'data')].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (_) {}
  }
  throw new Error('No writable data directory');
}

const DATA_DIR = resolveDataDir();
const DB_FILE = path.join(DATA_DIR, 'db.json');
console.log('Data directory:', DATA_DIR);

const COLLECTIONS = [
  'supervisors',
  'employees',
  'departments',
  'attendance',
  'director_attendance',
  'archived_attendance'
];

let store = null;

function loadStore() {
  if (fs.existsSync(DB_FILE)) {
    try {
      store = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      console.error('DB file corrupted, starting fresh:', e.message);
      store = {};
    }
  } else {
    store = {};
  }
  for (const c of COLLECTIONS) if (!store[c]) store[c] = {};
  seedAdmin();
  persist();
}

let writeQueue = Promise.resolve();
function persist() {
  writeQueue = writeQueue.then(() => new Promise((resolve, reject) => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8', err => {
      if (err) return reject(err);
      fs.rename(tmp, DB_FILE, err2 => err2 ? reject(err2) : resolve());
    });
  })).catch(err => console.error('Persist error:', err.message));
  return writeQueue;
}

function seedAdmin() {
  const sups = store.supervisors;
  const hasAdmin = Object.values(sups).some(u => u && u.username === 'admin');
  if (!hasAdmin) {
    const id = genId();
    sups[id] = {
      name: 'مدير النظام',
      username: 'admin',
      password: 'admin123',
      role: 'admin',
      dept: '',
      director: ''
    };
    console.log('Seeded admin user (admin / admin123)');
  }
}

function genId() {
  // Firestore-style 20-char id
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function ensureCollection(name) {
  if (!COLLECTIONS.includes(name)) return false;
  if (!store[name]) store[name] = {};
  return true;
}

function matchFilters(doc, filters) {
  if (!filters || !filters.length) return true;
  for (const f of filters) {
    const v = doc[f.field];
    if (f.op === '==') {
      if (v !== f.value) return false;
    } else if (f.op === 'in') {
      if (!Array.isArray(f.value) || !f.value.includes(v)) return false;
    } else if (f.op === '!=') {
      if (v === f.value) return false;
    } else {
      return false;
    }
  }
  return true;
}

// ── API ──────────────────────────────────────────────
app.get('/api/collections/:name', (req, res) => {
  const name = req.params.name;
  if (!ensureCollection(name)) return res.status(400).json({ error: 'unknown collection' });
  let filters = [];
  if (req.query.filters) {
    try { filters = JSON.parse(req.query.filters); } catch (_) {
      return res.status(400).json({ error: 'bad filters' });
    }
  }
  const docs = Object.entries(store[name])
    .filter(([, data]) => matchFilters(data, filters))
    .map(([id, data]) => ({ id, ...data }));
  res.json(docs);
});

app.get('/api/collections/:name/:id', (req, res) => {
  const { name, id } = req.params;
  if (!ensureCollection(name)) return res.status(400).json({ error: 'unknown collection' });
  const data = store[name][id];
  if (!data) return res.status(404).json({ error: 'not found' });
  res.json({ id, ...data });
});

app.post('/api/collections/:name', async (req, res) => {
  const name = req.params.name;
  if (!ensureCollection(name)) return res.status(400).json({ error: 'unknown collection' });
  const id = genId();
  store[name][id] = req.body || {};
  await persist();
  res.json({ id });
});

app.put('/api/collections/:name/:id', async (req, res) => {
  const { name, id } = req.params;
  if (!ensureCollection(name)) return res.status(400).json({ error: 'unknown collection' });
  store[name][id] = req.body || {};
  await persist();
  res.json({ ok: true });
});

app.patch('/api/collections/:name/:id', async (req, res) => {
  const { name, id } = req.params;
  if (!ensureCollection(name)) return res.status(400).json({ error: 'unknown collection' });
  const current = store[name][id] || {};
  store[name][id] = { ...current, ...(req.body || {}) };
  await persist();
  res.json({ ok: true });
});

app.delete('/api/collections/:name/:id', async (req, res) => {
  const { name, id } = req.params;
  if (!ensureCollection(name)) return res.status(400).json({ error: 'unknown collection' });
  delete store[name][id];
  await persist();
  res.json({ ok: true });
});

app.post('/api/batch', async (req, res) => {
  const ops = Array.isArray(req.body) ? req.body : [];
  const results = [];
  for (const op of ops) {
    if (!ensureCollection(op.collection)) return res.status(400).json({ error: 'unknown collection ' + op.collection });
    const col = store[op.collection];
    if (op.op === 'set') {
      const id = op.id || genId();
      col[id] = op.data || {};
      results.push({ id });
    } else if (op.op === 'update') {
      const current = col[op.id] || {};
      col[op.id] = { ...current, ...(op.data || {}) };
      results.push({ id: op.id });
    } else if (op.op === 'delete') {
      delete col[op.id];
      results.push({ id: op.id });
    } else {
      return res.status(400).json({ error: 'bad op ' + op.op });
    }
  }
  await persist();
  res.json({ ok: true, results });
});

// ── ملفات ثابتة ─────────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

loadStore();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
