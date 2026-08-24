import express from 'express'
import cors from 'cors'
import fs from 'fs'
import pg from 'pg'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'
import path from 'path'

const { Pool } = pg

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_PATH ?? __dirname
const DB_PATH = path.join(DATA_DIR, 'trades.json')
const PROP_FIRM_PATH = path.join(DATA_DIR, 'prop_firm.json')
const SCANNER_ALERTS_PATH = path.join(DATA_DIR, 'scanner_alerts.json')
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads')
const PORT = process.env.PORT ?? 3001

const DEFAULT_PROP_FIRM = {
  provider: '5ers',
  account_size: 200000,
  phase: 'Step 1 (8/5 Plan)',
  starting_balance: 200000,
  current_balance: 200000,
  profit_target: 16000,
  max_daily_drawdown: 6000,
  max_total_drawdown: 20000,
  trades_taken: 0,
  max_trades: null,
  notes: 'Summer Plan Classic 200K, 8/5 Plan (279$). Step 1 target 8%, Step 2 target 5%. Perte max journaliere 3% (EOD), perte max totale 10%.',
}

// Postgres (Neon) if DATABASE_URL is set, otherwise fall back to local JSON files.
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null

if (!pool) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '[]')
  if (!fs.existsSync(SCANNER_ALERTS_PATH)) fs.writeFileSync(SCANNER_ALERTS_PATH, '[]')
}

async function initDb() {
  if (!pool) return

  await pool.query('CREATE TABLE IF NOT EXISTS trades (id UUID PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), data JSONB NOT NULL)')
  await pool.query('CREATE TABLE IF NOT EXISTS prop_firm (id INT PRIMARY KEY, data JSONB NOT NULL)')
  await pool.query('CREATE TABLE IF NOT EXISTS scanner_alerts (id UUID PRIMARY KEY, received_at TIMESTAMPTZ NOT NULL DEFAULT now(), data JSONB NOT NULL)')

  // One-time seed from the legacy JSON files (or defaults) so the migration to
  // Postgres doesn't lose whatever was already tracked.
  const { rows: tradeCount } = await pool.query('SELECT COUNT(*) FROM trades')
  if (Number(tradeCount[0].count) === 0 && fs.existsSync(DB_PATH)) {
    const existing = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))
    for (const trade of existing) {
      await pool.query('INSERT INTO trades (id, created_at, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [trade.id, trade.timestamp ?? new Date().toISOString(), trade])
    }
  }

  const { rows: pfCount } = await pool.query('SELECT COUNT(*) FROM prop_firm')
  if (Number(pfCount[0].count) === 0) {
    const existing = fs.existsSync(PROP_FIRM_PATH) ? JSON.parse(fs.readFileSync(PROP_FIRM_PATH, 'utf8')) : DEFAULT_PROP_FIRM
    await pool.query('INSERT INTO prop_firm (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [existing])
  }

  const { rows: alertCount } = await pool.query('SELECT COUNT(*) FROM scanner_alerts')
  if (Number(alertCount[0].count) === 0 && fs.existsSync(SCANNER_ALERTS_PATH)) {
    const existing = JSON.parse(fs.readFileSync(SCANNER_ALERTS_PATH, 'utf8'))
    for (const alert of existing) {
      await pool.query('INSERT INTO scanner_alerts (id, received_at, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [alert.id, alert.received_at ?? new Date().toISOString(), alert])
    }
  }
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '20mb' }))
app.use(express.static(path.join(__dirname, 'public')))
app.use('/vendor/vue', express.static(path.join(__dirname, 'node_modules', 'vue', 'dist')))
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three', 'build')))

fs.mkdirSync(UPLOADS_DIR, { recursive: true })

// SSE clients
const clients = new Set()

// ---------- Trades ----------

async function readTrades() {
  if (pool) {
    const { rows } = await pool.query('SELECT data FROM trades ORDER BY created_at ASC')
    return rows.map(r => r.data)
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))
}

async function insertTrade(trade) {
  if (pool) {
    await pool.query('INSERT INTO trades (id, created_at, data) VALUES ($1, $2, $3)', [trade.id, trade.timestamp, trade])
    return trade
  }
  const trades = await readTrades()
  trades.push(trade)
  fs.writeFileSync(DB_PATH, JSON.stringify(trades, null, 2))
  return trade
}

async function updateTrade(id, updater) {
  if (pool) {
    const { rows } = await pool.query('SELECT data FROM trades WHERE id = $1', [id])
    if (!rows.length) return null
    const next = updater(rows[0].data)
    await pool.query('UPDATE trades SET data = $1 WHERE id = $2', [next, id])
    return next
  }
  const trades = await readTrades()
  const idx = trades.findIndex(t => t.id === id)
  if (idx === -1) return null
  trades[idx] = updater(trades[idx])
  fs.writeFileSync(DB_PATH, JSON.stringify(trades, null, 2))
  return trades[idx]
}

async function deleteTrade(id) {
  if (pool) {
    const result = await pool.query('DELETE FROM trades WHERE id = $1', [id])
    return result.rowCount > 0
  }
  const trades = await readTrades()
  const filtered = trades.filter(t => t.id !== id)
  if (filtered.length === trades.length) return false
  fs.writeFileSync(DB_PATH, JSON.stringify(filtered, null, 2))
  return true
}

// ---------- Prop firm ----------

async function readPropFirm() {
  if (pool) {
    const { rows } = await pool.query('SELECT data FROM prop_firm WHERE id = 1')
    return rows[0]?.data ?? DEFAULT_PROP_FIRM
  }
  if (!fs.existsSync(PROP_FIRM_PATH)) return DEFAULT_PROP_FIRM
  return JSON.parse(fs.readFileSync(PROP_FIRM_PATH, 'utf8'))
}

async function writePropFirm(config) {
  if (pool) {
    await pool.query(
      'INSERT INTO prop_firm (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1',
      [config],
    )
    return
  }
  fs.writeFileSync(PROP_FIRM_PATH, JSON.stringify(config, null, 2))
}

// ---------- Scanner alerts ----------

async function readScannerAlerts() {
  if (pool) {
    const { rows } = await pool.query('SELECT data FROM scanner_alerts ORDER BY received_at ASC')
    return rows.map(r => r.data)
  }
  return JSON.parse(fs.readFileSync(SCANNER_ALERTS_PATH, 'utf8'))
}

async function insertScannerAlert(alert) {
  if (pool) {
    await pool.query('INSERT INTO scanner_alerts (id, received_at, data) VALUES ($1, $2, $3)', [alert.id, alert.received_at, alert])
    return alert
  }
  const alerts = await readScannerAlerts()
  alerts.push(alert)
  fs.writeFileSync(SCANNER_ALERTS_PATH, JSON.stringify(alerts, null, 2))
  return alert
}

async function updateScannerAlert(id, updater) {
  if (pool) {
    const { rows } = await pool.query('SELECT data FROM scanner_alerts WHERE id = $1', [id])
    if (!rows.length) return null
    const next = updater(rows[0].data)
    await pool.query('UPDATE scanner_alerts SET data = $1 WHERE id = $2', [next, id])
    return next
  }
  const alerts = await readScannerAlerts()
  const idx = alerts.findIndex(a => a.id === id)
  if (idx === -1) return null
  alerts[idx] = updater(alerts[idx])
  fs.writeFileSync(SCANNER_ALERTS_PATH, JSON.stringify(alerts, null, 2))
  return alerts[idx]
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  clients.forEach(res => res.write(payload))
}

// SSE stream
app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // send current state on connect
  res.write(`event: init\ndata: ${JSON.stringify(await readTrades())}\n\n`)

  clients.add(res)
  req.on('close', () => clients.delete(res))
})

// GET all trades
app.get('/api/trades', async (req, res) => {
  res.json(await readTrades())
})

// POST new trade (called by Claude after each ATM analysis)
app.post('/api/trades', async (req, res) => {
  const {
    symbol,
    direction,
    timeframe,
    entry,
    sl,
    tp1,
    tp2,
    rr,
    note,
    pillars,
    comment,
    strategy,
    session,
    image_url,
    setup,
    tags,
    fees,
    risk_pct,
    position_size,
    prop_firm,
  } = req.body

  const trade = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    symbol: symbol ?? 'UNKNOWN',
    direction: direction ?? 'LONG',       // 'LONG' | 'SHORT'
    timeframe: timeframe ?? '4H',
    entry: entry ?? null,
    sl: sl ?? null,
    tp1: tp1 ?? null,
    tp2: tp2 ?? null,
    rr: rr ?? null,
    note: note ?? null,                   // /10
    pillars: pillars ?? {                 // ATM 3 pillars
      prix: null,
      momentum: null,
      structure: null,
    },
    strategy: strategy ?? 'ATM',
    session: session ?? null,              // Asia | London | New York | Other
    image_url: image_url ?? '',
    setup: setup ?? '',
    tags: Array.isArray(tags) ? tags : [],
    fees: fees ?? null,
    risk_pct: risk_pct ?? null,
    position_size: position_size ?? null,
    prop_firm: prop_firm ?? false,
    comment: comment ?? '',
    status: 'open',                       // 'open' | 'win' | 'loss' | 'breakeven'
    result_price: null,
    pnl_pct: null,
    pnl_amount: null,
    closed_at: null,
  }

  await insertTrade(trade)
  broadcast('trade_added', trade)

  res.status(201).json(trade)
})

// PATCH close a trade (you give Claude the result)
app.patch('/api/trades/:id', async (req, res) => {
  const editableFields = [
    'symbol',
    'direction',
    'timeframe',
    'entry',
    'sl',
    'tp1',
    'tp2',
    'rr',
    'note',
    'pillars',
    'comment',
    'status',
    'result_price',
    'pnl_pct',
    'pnl_amount',
    'strategy',
    'session',
    'image_url',
    'setup',
    'tags',
    'fees',
    'risk_pct',
    'position_size',
    'prop_firm',
  ]

  const updates = {}
  editableFields.forEach(field => {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      updates[field] = req.body[field]
    }
  })

  const updated = await updateTrade(req.params.id, current => ({
    ...current,
    ...updates,
    updated_at: new Date().toISOString(),
    closed_at: updates.status && updates.status !== 'open'
      ? (current.closed_at ?? new Date().toISOString())
      : updates.status === 'open'
        ? null
        : current.closed_at,
  }))

  if (!updated) return res.status(404).json({ error: 'not found' })

  broadcast('trade_updated', updated)
  res.json(updated)
})

// DELETE a trade
app.delete('/api/trades/:id', async (req, res) => {
  const deleted = await deleteTrade(req.params.id)
  if (!deleted) return res.status(404).json({ error: 'not found' })

  broadcast('trade_deleted', { id: req.params.id })
  res.status(204).end()
})

app.post('/api/uploads', (req, res) => {
  const { filename = 'trade.png', data_url } = req.body
  if (!data_url || !data_url.startsWith('data:image/')) {
    return res.status(400).json({ error: 'data_url image required' })
  }

  const match = data_url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
  if (!match) return res.status(400).json({ error: 'invalid data_url' })

  const extension = match[1].split('/')[1].replace('jpeg', 'jpg')
  const safeName = filename.replace(/[^a-z0-9._-]/gi, '-').toLowerCase()
  const storedName = `${Date.now()}-${randomUUID()}-${safeName}.${extension}`
  const filePath = path.join(UPLOADS_DIR, storedName)

  fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'))
  res.status(201).json({ image_url: `/uploads/${storedName}` })
})

app.get('/api/prop-firm', async (req, res) => {
  res.json(await readPropFirm())
})

app.put('/api/prop-firm', async (req, res) => {
  const next = { ...(await readPropFirm()), ...req.body, updated_at: new Date().toISOString() }
  await writePropFirm(next)
  broadcast('prop_firm_updated', next)
  res.json(next)
})

// Webhook receiver for harmonicpattern.com (or any scanner) pattern alerts.
// Payload shape is not assumed beyond the known { msg_type, data: [...] } shape —
// unrecognized fields are kept under `payload` so Claude can interpret them.
function normalizeAlert(item) {
  // "id" comes from /account/notification pulls; webhook payloads don't include
  // one, so fall back to parsing it from the notification URL (#noti/12345).
  const sourceId = item.id != null
    ? String(item.id)
    : (typeof item.url === 'string' ? item.url.match(/noti\/(\d+)/)?.[1] ?? null : null)

  return {
    id: randomUUID(),
    received_at: new Date().toISOString(),
    status: 'pending', // 'pending' | 'reviewed'
    reviewed_at: null,
    verdict: null, // e.g. 'valid_setup' | 'rejected'
    note: null,
    source_id: sourceId, // harmonicpattern.com notification id, for dedup across pulls
    pattern_type: item.patterntype ?? null,   // 'bullish' | 'bearish'
    pattern_name: item.patternname ?? null,   // e.g. 'deep crab'
    pattern_class: item.patternclass ?? null, // 'harmonic' | 'chart' | ...
    pattern_status: item.status ?? null,      // 'complete' | ...
    symbol: item.displaySymbol ?? item.symbol ?? null,
    broker_symbol: item.symbol ?? null,
    timeframe: item.timeframe ?? null,
    entry: item.entry ?? null,
    stoploss: item.stoploss ?? null,
    profit1: item.profit1 ?? null,
    profit2: item.profit2 ?? null,
    rrratio: item.rrratio ?? null,
    source_url: item.url ?? null,
    payload: item,
  }
}

async function scannerAlertExistsBySourceId(sourceId) {
  if (!sourceId) return false
  if (pool) {
    const { rows } = await pool.query("SELECT 1 FROM scanner_alerts WHERE data->>'source_id' = $1 LIMIT 1", [sourceId])
    return rows.length > 0
  }
  const alerts = await readScannerAlerts()
  return alerts.some(a => a.source_id === sourceId)
}

app.post('/api/scanner-alerts', async (req, res) => {
  // harmonicpattern.com sends { msg_type, data: [...] } — one message can carry
  // several pattern notifications at once. Fall back to treating the whole body
  // as a single item for any other scanner that might post here later.
  const items = Array.isArray(req.body?.data) ? req.body.data : [req.body]

  const created = []
  for (const item of items) {
    const alert = normalizeAlert(item)
    await insertScannerAlert(alert)
    created.push(alert)
  }

  created.forEach(alert => broadcast('scanner_alert_received', alert))

  res.status(201).json({ received: created.length, alerts: created })
})

// Pull-based alternative to the webhook: fetch latest notifications directly
// from harmonicpattern.com's API (GET /account/notification) using a stored
// API key, and store only the ones we don't already have (dedup by source_id).
app.post('/api/scanner-sync', async (req, res) => {
  const apiKey = process.env.HARMONIC_API_KEY
  if (!apiKey) return res.status(400).json({ error: 'HARMONIC_API_KEY not configured' })

  let notifications
  try {
    const response = await fetch(`https://harmonicpattern.com/api/v1/account/notification?token=${apiKey}`)
    if (!response.ok) {
      return res.status(502).json({ error: `harmonicpattern.com responded ${response.status}` })
    }
    notifications = await response.json()
  } catch (err) {
    return res.status(502).json({ error: `Failed to reach harmonicpattern.com: ${err.message}` })
  }

  if (!Array.isArray(notifications)) {
    return res.status(502).json({ error: 'Unexpected response shape from harmonicpattern.com', received: notifications })
  }

  const created = []
  for (const item of notifications) {
    const alert = normalizeAlert(item)
    if (await scannerAlertExistsBySourceId(alert.source_id)) continue
    await insertScannerAlert(alert)
    created.push(alert)
  }

  created.forEach(alert => broadcast('scanner_alert_received', alert))

  res.json({ fetched: notifications.length, created: created.length, alerts: created })
})

// GET alerts, optionally filtered by status (?status=pending)
app.get('/api/scanner-alerts', async (req, res) => {
  const alerts = await readScannerAlerts()
  const { status } = req.query
  res.json(status ? alerts.filter(a => a.status === status) : alerts)
})

// Mark an alert as reviewed once Claude has analyzed it
app.patch('/api/scanner-alerts/:id', async (req, res) => {
  const editableFields = ['status', 'verdict', 'note']
  const updates = {}
  editableFields.forEach(field => {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      updates[field] = req.body[field]
    }
  })

  const updated = await updateScannerAlert(req.params.id, current => ({
    ...current,
    ...updates,
    reviewed_at: updates.status === 'reviewed' ? (current.reviewed_at ?? new Date().toISOString()) : current.reviewed_at,
  }))

  if (!updated) return res.status(404).json({ error: 'not found' })

  broadcast('scanner_alert_updated', updated)
  res.json(updated)
})

// stats endpoint (bonus)
app.get('/api/stats', async (req, res) => {
  const trades = await readTrades()
  const closed = trades.filter(t => t.status !== 'open')
  const wins = closed.filter(t => t.status === 'win')
  const longTrades = trades.filter(t => t.direction === 'LONG')
  const shortTrades = trades.filter(t => t.direction === 'SHORT')
  const propFirm = await readPropFirm()
  const pnlAmount = trades.reduce((s, t) => s + (Number(t.pnl_amount) || 0), 0)
  const currentBalance = Number(propFirm.current_balance) || Number(propFirm.starting_balance) || 200000
  const startingBalance = Number(propFirm.starting_balance) || 200000
  const drawdown = Math.max(0, startingBalance - currentBalance)

  res.json({
    total: trades.length,
    open: trades.filter(t => t.status === 'open').length,
    closed: closed.length,
    win_rate: closed.length ? Math.round((wins.length / closed.length) * 100) : null,
    avg_note: trades.length
      ? +(trades.reduce((s, t) => s + (t.note ?? 0), 0) / trades.length).toFixed(2)
      : null,
    avg_rr: closed.length
      ? +(closed.reduce((s, t) => s + (t.rr ?? 0), 0) / closed.length).toFixed(2)
      : null,
    avg_pnl_pct: closed.length
      ? +(closed.reduce((s, t) => s + (t.pnl_pct ?? 0), 0) / closed.length).toFixed(2)
      : null,
    long_count: longTrades.length,
    short_count: shortTrades.length,
    pnl_amount: +pnlAmount.toFixed(2),
    prop_firm_progress: {
      current_balance: currentBalance,
      profit_target_pct: propFirm.profit_target
        ? Math.min(100, Math.max(0, ((currentBalance - startingBalance) / propFirm.profit_target) * 100))
        : 0,
      drawdown_used_pct: propFirm.max_total_drawdown
        ? Math.min(100, Math.max(0, (drawdown / propFirm.max_total_drawdown) * 100))
        : 0,
    },
  })
})

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`track_record API running on http://localhost:${PORT} (storage: ${pool ? 'postgres' : 'json files'})`)
    })
  })
  .catch(err => {
    console.error('Failed to initialize database', err)
    process.exit(1)
  })
