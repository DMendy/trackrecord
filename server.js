import express from 'express'
import cors from 'cors'
import fs from 'fs'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_PATH ?? __dirname
const DB_PATH = path.join(DATA_DIR, 'trades.json')
const PROP_FIRM_PATH = path.join(DATA_DIR, 'prop_firm.json')
const SCANNER_ALERTS_PATH = path.join(DATA_DIR, 'scanner_alerts.json')
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads')
const PORT = process.env.PORT ?? 3001

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '[]')
if (!fs.existsSync(SCANNER_ALERTS_PATH)) fs.writeFileSync(SCANNER_ALERTS_PATH, '[]')

const app = express()
app.use(cors())
app.use(express.json({ limit: '20mb' }))
app.use(express.static(path.join(__dirname, 'public')))
app.use('/vendor/vue', express.static(path.join(__dirname, 'node_modules', 'vue', 'dist')))
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three', 'build')))

fs.mkdirSync(UPLOADS_DIR, { recursive: true })

// SSE clients
const clients = new Set()

function readTrades() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))
}

function writeTrades(trades) {
  fs.writeFileSync(DB_PATH, JSON.stringify(trades, null, 2))
}

function readPropFirm() {
  if (!fs.existsSync(PROP_FIRM_PATH)) {
    return {
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
  }

  return JSON.parse(fs.readFileSync(PROP_FIRM_PATH, 'utf8'))
}

function writePropFirm(config) {
  fs.writeFileSync(PROP_FIRM_PATH, JSON.stringify(config, null, 2))
}

function readScannerAlerts() {
  return JSON.parse(fs.readFileSync(SCANNER_ALERTS_PATH, 'utf8'))
}

function writeScannerAlerts(alerts) {
  fs.writeFileSync(SCANNER_ALERTS_PATH, JSON.stringify(alerts, null, 2))
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  clients.forEach(res => res.write(payload))
}

// SSE stream
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // send current state on connect
  res.write(`event: init\ndata: ${JSON.stringify(readTrades())}\n\n`)

  clients.add(res)
  req.on('close', () => clients.delete(res))
})

// GET all trades
app.get('/api/trades', (req, res) => {
  res.json(readTrades())
})

// POST new trade (called by Claude after each ATM analysis)
app.post('/api/trades', (req, res) => {
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

  const trades = readTrades()
  trades.push(trade)
  writeTrades(trades)
  broadcast('trade_added', trade)

  res.status(201).json(trade)
})

// PATCH close a trade (you give Claude the result)
app.patch('/api/trades/:id', (req, res) => {
  const trades = readTrades()
  const idx = trades.findIndex(t => t.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: 'not found' })

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

  trades[idx] = {
    ...trades[idx],
    ...updates,
    updated_at: new Date().toISOString(),
    closed_at: updates.status && updates.status !== 'open'
      ? (trades[idx].closed_at ?? new Date().toISOString())
      : updates.status === 'open'
        ? null
        : trades[idx].closed_at,
  }

  writeTrades(trades)
  broadcast('trade_updated', trades[idx])

  res.json(trades[idx])
})

// DELETE a trade
app.delete('/api/trades/:id', (req, res) => {
  const trades = readTrades()
  const filtered = trades.filter(t => t.id !== req.params.id)
  if (filtered.length === trades.length) return res.status(404).json({ error: 'not found' })

  writeTrades(filtered)
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

app.get('/api/prop-firm', (req, res) => {
  res.json(readPropFirm())
})

app.put('/api/prop-firm', (req, res) => {
  const next = { ...readPropFirm(), ...req.body, updated_at: new Date().toISOString() }
  writePropFirm(next)
  broadcast('prop_firm_updated', next)
  res.json(next)
})

// Webhook receiver for harmonicpattern.com (or any scanner) pattern alerts.
// Payload shape is not assumed — whatever JSON the scanner sends is stored as-is
// under `payload`, so Claude can interpret it when reviewing on demand.
app.post('/api/scanner-alerts', (req, res) => {
  const alert = {
    id: randomUUID(),
    received_at: new Date().toISOString(),
    status: 'pending', // 'pending' | 'reviewed'
    reviewed_at: null,
    verdict: null, // e.g. 'valid_setup' | 'rejected'
    note: null,
    payload: req.body,
  }

  const alerts = readScannerAlerts()
  alerts.push(alert)
  writeScannerAlerts(alerts)
  broadcast('scanner_alert_received', alert)

  res.status(201).json(alert)
})

// GET alerts, optionally filtered by status (?status=pending)
app.get('/api/scanner-alerts', (req, res) => {
  const alerts = readScannerAlerts()
  const { status } = req.query
  res.json(status ? alerts.filter(a => a.status === status) : alerts)
})

// Mark an alert as reviewed once Claude has analyzed it
app.patch('/api/scanner-alerts/:id', (req, res) => {
  const alerts = readScannerAlerts()
  const idx = alerts.findIndex(a => a.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: 'not found' })

  const editableFields = ['status', 'verdict', 'note']
  const updates = {}
  editableFields.forEach(field => {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      updates[field] = req.body[field]
    }
  })

  alerts[idx] = {
    ...alerts[idx],
    ...updates,
    reviewed_at: updates.status === 'reviewed' ? (alerts[idx].reviewed_at ?? new Date().toISOString()) : alerts[idx].reviewed_at,
  }

  writeScannerAlerts(alerts)
  broadcast('scanner_alert_updated', alerts[idx])

  res.json(alerts[idx])
})

// stats endpoint (bonus)
app.get('/api/stats', (req, res) => {
  const trades = readTrades()
  const closed = trades.filter(t => t.status !== 'open')
  const wins = closed.filter(t => t.status === 'win')
  const longTrades = trades.filter(t => t.direction === 'LONG')
  const shortTrades = trades.filter(t => t.direction === 'SHORT')
  const propFirm = readPropFirm()
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

app.listen(PORT, () => {
  console.log(`track_record API running on http://localhost:${PORT}`)
})
