import express from 'express'
import cors from 'cors'
import fs from 'fs'
import pg from 'pg'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'
import path from 'path'
import { syncMyfxbook } from './myfxbook-sync.js'

const { Pool } = pg

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_PATH ?? __dirname
const DB_PATH = path.join(DATA_DIR, 'trades.json')
const PROP_FIRM_PATH = path.join(DATA_DIR, 'prop_firm.json')
const ACCOUNTS_PATH = path.join(DATA_DIR, 'accounts.json')
const PLAN_PATH = path.join(DATA_DIR, 'plan.json')
const VIOLATIONS_PATH = path.join(DATA_DIR, 'plan_violations.json')
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

// Comptes suivis. Le track record est splitte par compte via un selecteur en
// haut de l'app ; chaque trade porte un `account_id`. `myfxbook_account_id` =
// compte synchronise automatiquement (Myfxbook). Editable via /api/accounts.
const DEFAULT_ACCOUNTS = [
  {
    id: '12171072',
    label: '5ers 200K · 8%',
    provider: '5ers',
    myfxbook_account_id: '12171072',
    account_size: 200000,
    phase: 'Step 1 (8/5 Plan)',
    starting_balance: 200000,
    current_balance: 200000,
    profit_target: 16000,
    max_daily_drawdown: 6000,
    max_total_drawdown: 20000,
    trades_taken: 0,
    max_trades: null,
    notes: 'Summer Plan Classic 200K, 8/5 Plan. Step 1 target 8%.',
  },
  {
    id: '26637976',
    label: '5ers 200K · 10%',
    provider: '5ers',
    myfxbook_account_id: '12175704', // Myfxbook "pour dodo" (l'id 26637976 fourni au depart etait le login 5ers)
    account_size: 200000,
    phase: 'Step 1',
    starting_balance: 200000,
    current_balance: 200000,
    profit_target: 20000,
    max_daily_drawdown: 6000,
    max_total_drawdown: 20000,
    trades_taken: 0,
    max_trades: null,
    notes: 'Compte repris. Step 1 target 10%, sinon identique au 200K 8%.',
  },
]

// Regles du plan de trading, evaluees a chaque ouverture / cloture de trade.
// Editable a chaud via PUT /api/plan.
const DEFAULT_PLAN = {
  max_trades_per_day: 1,
  risk_pct_min: 0.9,
  risk_pct_max: 1.1,
  min_rr: 3,
  notes: '1 trade/jour, risque 1% (tolere 0,9-1,1%), RR minimum 3.',
}

// Postgres (Neon) if DATABASE_URL is set, otherwise fall back to local JSON files.
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null

if (!pool) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '[]')
  if (!fs.existsSync(VIOLATIONS_PATH)) fs.writeFileSync(VIOLATIONS_PATH, '[]')
}

async function initDb() {
  if (!pool) return

  await pool.query('CREATE TABLE IF NOT EXISTS trades (id UUID PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), data JSONB NOT NULL)')
  await pool.query('CREATE TABLE IF NOT EXISTS prop_firm (id INT PRIMARY KEY, data JSONB NOT NULL)')
  await pool.query('CREATE TABLE IF NOT EXISTS accounts (id INT PRIMARY KEY, data JSONB NOT NULL)')
  await pool.query('CREATE TABLE IF NOT EXISTS plan (id INT PRIMARY KEY, data JSONB NOT NULL)')
  await pool.query('CREATE TABLE IF NOT EXISTS plan_violations (id UUID PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), data JSONB NOT NULL)')

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

  const { rows: accCount } = await pool.query('SELECT COUNT(*) FROM accounts')
  if (Number(accCount[0].count) === 0) {
    // Seed from the legacy single prop_firm row (keeps whatever balance /
    // drawdown was already synced) as account 1, then add the reprised challenge.
    const { rows: pfRows } = await pool.query('SELECT data FROM prop_firm WHERE id = 1')
    await pool.query('INSERT INTO accounts (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [JSON.stringify(buildSeedAccounts(pfRows[0]?.data))])
  }

  const { rows: planCount } = await pool.query('SELECT COUNT(*) FROM plan')
  if (Number(planCount[0].count) === 0) {
    const existing = fs.existsSync(PLAN_PATH) ? JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8')) : DEFAULT_PLAN
    await pool.query('INSERT INTO plan (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [existing])
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

// ---------- Accounts (prop firm challenges) ----------

// Merge the legacy single prop_firm blob into account 1 so a live balance /
// drawdown already synced on Render isn't lost, then append the 2nd challenge.
function buildSeedAccounts(legacyPropFirm) {
  const base = DEFAULT_ACCOUNTS.map(a => ({ ...a }))
  if (legacyPropFirm && typeof legacyPropFirm === 'object') {
    base[0] = {
      ...base[0],
      ...legacyPropFirm,
      id: base[0].id,
      label: base[0].label,
      myfxbook_account_id: process.env.MYFXBOOK_ACCOUNT_ID ?? base[0].myfxbook_account_id,
    }
  }
  return base
}

async function readAccounts() {
  if (pool) {
    const { rows } = await pool.query('SELECT data FROM accounts WHERE id = 1')
    return Array.isArray(rows[0]?.data) ? rows[0].data : DEFAULT_ACCOUNTS
  }
  if (!fs.existsSync(ACCOUNTS_PATH)) return DEFAULT_ACCOUNTS
  const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'))
  return Array.isArray(parsed) ? parsed : DEFAULT_ACCOUNTS
}

async function writeAccounts(list) {
  if (pool) {
    // JSONB param must be a string — pg turns a raw JS array into a Postgres
    // array literal otherwise.
    await pool.query('INSERT INTO accounts (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1', [JSON.stringify(list)])
    return
  }
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(list, null, 2))
}

// Filet de securite : le stockage garde TOUS les comptes dans un seul
// enregistrement (`accounts` id=1, un tableau JSONB). Si un compte par defaut
// manque a l'appel (seed partiel, edition manuelle), on l'ajoute sans toucher
// aux comptes deja presents ni a leurs reglages.
async function ensureDefaultAccounts() {
  const current = await readAccounts()
  const haveIds = new Set(current.map(a => a.id))
  const missing = DEFAULT_ACCOUNTS.filter(a => !haveIds.has(a.id))
  if (!missing.length) return
  await writeAccounts([...current, ...missing])
  console.log(`[migrate] comptes: ajout de ${missing.map(a => a.label).join(', ')}`)
}

async function writeTradesBulk(allTrades, { toUpdate = [], toDelete = [] }) {
  if (!toUpdate.length && !toDelete.length) return
  if (pool) {
    for (const u of toUpdate) await pool.query('UPDATE trades SET data = $1 WHERE id = $2', [u, u.id])
    for (const id of toDelete) await pool.query('DELETE FROM trades WHERE id = $1', [id])
    return
  }
  const del = new Set(toDelete)
  const upd = new Map(toUpdate.map(u => [u.id, u]))
  const next = allTrades.filter(t => !del.has(t.id)).map(t => upd.get(t.id) || t)
  fs.writeFileSync(DB_PATH, JSON.stringify(next, null, 2))
}

// Repare les degats de l'ancienne version de backfillTradeAccounts, qui, a
// chaque demarrage, rattachait a tort les trades Myfxbook du 2e compte au
// compte 1 : `account_id` ecrase et `source_ref` double-prefixe
// (`myfxbook|<compte1>|<compte2>|...`). Comme la sync ne reconnaissait plus ces
// refs, elle reimportait ces trades a chaque cycle -> notifs Telegram en boucle.
// Ici on retablit le vrai compte a partir du 2e segment du ref, puis on
// dedoublonne sur l'identite corrigee (account_id inclus), en gardant le plus
// ancien. Idempotent : plus rien a corriger une fois les refs propres.
async function repairMyfxbookAccountRefs() {
  const accounts = await readAccounts()
  const known = new Set(accounts.map(a => a.id))
  if (!known.size) return

  const trades = await readTrades() // oldest first (created_at ASC in pg)
  const myfx = trades.filter(t => t.source === 'myfxbook')
  if (!myfx.length) return

  const unmangle = (t) => {
    const seg = typeof t.source_ref === 'string' ? t.source_ref.split('|') : []
    // myfxbook|<id connu>|<id connu>|<openTime>|... => double-prefixe par le bug.
    if (seg[0] === 'myfxbook' && known.has(seg[1]) && known.has(seg[2])) {
      return { ...t, account_id: seg[2], source_ref: ['myfxbook', ...seg.slice(2)].join('|') }
    }
    return t
  }

  const seen = new Set()
  const toUpdate = []
  const toDelete = []
  for (const orig of myfx) {
    const t = unmangle(orig)
    const key = [t.account_id ?? '', t.symbol, t.timestamp, t.closed_at, t.pnl_amount, t.direction].join('|')
    if (seen.has(key)) {
      toDelete.push(t.id)
      continue
    }
    seen.add(key)
    if (t.source_ref !== orig.source_ref || t.account_id !== orig.account_id) toUpdate.push(t)
  }

  if (!toUpdate.length && !toDelete.length) return
  await writeTradesBulk(trades, { toUpdate, toDelete })
  console.log(`[repair] myfxbook refs: ${toUpdate.length} corrige(s), ${toDelete.length} doublon(s) supprime(s)`)
}

// Rattache au compte 1 les seuls vrais trades "pre-split" : ceux dont
// l'account_id ne correspond a aucun compte connu (import d'avant le split
// multi-comptes). Ne touche jamais aux trades deja rattaches a un compte connu.
async function backfillTradeAccounts() {
  const accounts = await readAccounts()
  const firstId = accounts[0]?.id
  if (!firstId) return
  const known = new Set(accounts.map(a => a.id))

  const trades = await readTrades()
  const legacy = trades.filter(t => t.source === 'myfxbook' && !known.has(t.account_id ?? null))
  if (!legacy.length) return

  const normRef = (ref) => {
    if (typeof ref !== 'string' || !ref.startsWith('myfxbook|')) return ref
    const seg = ref.split('|')
    if (known.has(seg[1])) return ref // deja au bon format
    return ['myfxbook', firstId, ...seg.slice(1)].join('|')
  }

  const toUpdate = []
  for (const t of legacy) {
    const nextRef = normRef(t.source_ref)
    if (t.account_id !== firstId || nextRef !== t.source_ref) {
      toUpdate.push({ ...t, account_id: firstId, source_ref: nextRef })
    }
  }

  if (!toUpdate.length) return
  await writeTradesBulk(trades, { toUpdate })
  console.log(`[migrate] myfxbook: ${toUpdate.length} trade(s) pre-split rattache(s) au compte ${firstId}`)
}

// Combined view used when no account is selected (the "Global" tab).
function combineAccounts(accounts) {
  const num = (v) => Number(v) || 0
  return accounts.reduce((acc, a) => ({
    starting_balance: acc.starting_balance + num(a.starting_balance),
    current_balance: acc.current_balance + num(a.current_balance),
    profit_target: acc.profit_target + num(a.profit_target),
    max_total_drawdown: acc.max_total_drawdown + num(a.max_total_drawdown),
    max_daily_drawdown: acc.max_daily_drawdown + num(a.max_daily_drawdown),
  }), { starting_balance: 0, current_balance: 0, profit_target: 0, max_total_drawdown: 0, max_daily_drawdown: 0 })
}

// ---------- Trading plan + violations ----------

async function readPlan() {
  if (pool) {
    const { rows } = await pool.query('SELECT data FROM plan WHERE id = 1')
    return rows[0]?.data ?? DEFAULT_PLAN
  }
  if (!fs.existsSync(PLAN_PATH)) return DEFAULT_PLAN
  return JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'))
}

async function writePlan(config) {
  if (pool) {
    await pool.query('INSERT INTO plan (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1', [config])
    return
  }
  fs.writeFileSync(PLAN_PATH, JSON.stringify(config, null, 2))
}

async function readViolations() {
  if (pool) {
    const { rows } = await pool.query('SELECT data FROM plan_violations ORDER BY created_at ASC')
    return rows.map(r => r.data)
  }
  return JSON.parse(fs.readFileSync(VIOLATIONS_PATH, 'utf8'))
}

async function insertViolation(violation) {
  if (pool) {
    await pool.query('INSERT INTO plan_violations (id, created_at, data) VALUES ($1, $2, $3)', [violation.id, violation.created_at, violation])
    return violation
  }
  const all = await readViolations()
  all.push(violation)
  fs.writeFileSync(VIOLATIONS_PATH, JSON.stringify(all, null, 2))
  return violation
}

async function updateViolation(id, updater) {
  if (pool) {
    const { rows } = await pool.query('SELECT data FROM plan_violations WHERE id = $1', [id])
    if (!rows.length) return null
    const next = updater(rows[0].data)
    await pool.query('UPDATE plan_violations SET data = $1 WHERE id = $2', [next, id])
    return next
  }
  const all = await readViolations()
  const idx = all.findIndex(v => v.id === id)
  if (idx === -1) return null
  all[idx] = updater(all[idx])
  fs.writeFileSync(VIOLATIONS_PATH, JSON.stringify(all, null, 2))
  return all[idx]
}

async function deleteViolationsForTrade(tradeId) {
  if (pool) {
    await pool.query("DELETE FROM plan_violations WHERE data->>'trade_id' = $1", [tradeId])
    return
  }
  const all = await readViolations()
  const filtered = all.filter(v => v.trade_id !== tradeId)
  if (filtered.length !== all.length) fs.writeFileSync(VIOLATIONS_PATH, JSON.stringify(filtered, null, 2))
}

// Calendar buckets a trade on its close day (fallback: open day) — keep the same
// key here so a violation badge lines up with the day cell it belongs to.
function tradeDayKey(trade) {
  return (trade.closed_at || trade.timestamp || '').slice(0, 10)
}

// Returns the list of plan rules this trade currently breaks. Missing values
// (no RR / no risk logged) are treated as "not journaled yet", not a breach —
// only a present-but-out-of-bounds value counts.
function evaluatePlan(trade, allTrades, plan) {
  const breaches = []
  const day = tradeDayKey(trade)
  const maxPerDay = plan.max_trades_per_day ?? 1
  const rMin = plan.risk_pct_min ?? 0.9
  const rMax = plan.risk_pct_max ?? 1.1
  const minRr = plan.min_rr ?? 3

  if (day) {
    // Per account: mirroring the same setup on both prop-firm challenges is one
    // decision, not two. Two different setups on the same account/day is the breach.
    const acct = trade.account_id ?? null
    const count = allTrades.filter(t => t.id !== trade.id && tradeDayKey(t) === day && (t.account_id ?? null) === acct).length + 1
    if (count > maxPerDay) {
      breaches.push({ rule: 'max_trades_per_day', message: `${count} trades pris le ${day} sur ce compte (plan : ${maxPerDay}/jour)` })
    }
  }

  const risk = Number(trade.risk_pct)
  if (Number.isFinite(risk) && (risk < rMin || risk > rMax)) {
    breaches.push({ rule: 'risk_pct', message: `Risque ${risk}% hors plan (${rMin}-${rMax}%)` })
  }

  const rr = Number(trade.rr)
  if (Number.isFinite(rr) && rr < minRr) {
    breaches.push({ rule: 'min_rr', message: `RR ${rr} sous le minimum (plan : >= ${minRr})` })
  }

  return breaches
}

const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return { skipped: true }
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
    })
    if (!res.ok) {
      console.error('[telegram]', res.status, (await res.text()).slice(0, 200))
      return { ok: false, status: res.status }
    }
    return { ok: true }
  } catch (err) {
    console.error('[telegram]', err.message)
    return { ok: false, error: err.message }
  }
}

// Re-evaluate one trade against the plan: record fresh breaches, resolve the
// ones that no longer apply, keep the calendar badges in sync. Telegram is
// handled separately by the notify* helpers. Called fire-and-forget from the
// trade routes so the HTTP response isn't blocked.
async function syncPlanViolations(trade) {
  const [plan, allTrades, existingAll] = await Promise.all([readPlan(), readTrades(), readViolations()])
  const breaches = evaluatePlan(trade, allTrades, plan)
  const brokenRules = new Set(breaches.map(b => b.rule))
  const mine = existingAll.filter(v => v.trade_id === trade.id)

  const fresh = []
  for (const breach of breaches) {
    if (mine.some(v => v.rule === breach.rule && !v.resolved)) continue
    const record = {
      id: randomUUID(),
      trade_id: trade.id,
      account_id: trade.account_id ?? null,
      rule: breach.rule,
      message: breach.message,
      date: tradeDayKey(trade),
      symbol: trade.symbol ?? null,
      direction: trade.direction ?? null,
      created_at: new Date().toISOString(),
      resolved: false,
      resolved_at: null,
    }
    await insertViolation(record)
    broadcast('violation_added', record)
    fresh.push(record)
  }

  for (const v of mine) {
    if (v.resolved || brokenRules.has(v.rule)) continue
    const updated = await updateViolation(v.id, current => ({ ...current, resolved: true, resolved_at: new Date().toISOString() }))
    if (updated) broadcast('violation_updated', updated)
  }

  return breaches
}

const fmtUsd = value => new Intl.NumberFormat('fr-FR', {
  style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0,
}).format(Number(value) || 0)

// Balance = solde de depart du compte + somme des PnL clotures. Reflete le
// trade qu'on vient de fermer tout de suite (le solde Myfxbook, lui, ne bouge
// qu'a la prochaine sync).
async function accountBalanceLive(accountId) {
  const accounts = await readAccounts()
  const acc = accounts.find(a => a.id === accountId)
  if (!acc) return null
  const trades = await readTrades()
  const start = Number(acc.starting_balance) || Number(acc.account_size) || 0
  const realized = trades
    .filter(t => t.account_id === accountId && t.status !== 'open')
    .reduce((s, t) => s + (Number(t.pnl_amount) || 0), 0)
  return { label: acc.label, balance: start + realized }
}

// Notif Telegram a l'ouverture d'un trade : "plan respecte" ou "plan non respecte".
async function notifyTradeOpened(trade) {
  const [plan, allTrades, accounts] = await Promise.all([readPlan(), readTrades(), readAccounts()])
  const breaches = evaluatePlan(trade, allTrades, plan)
  const head = `${trade.symbol ?? '?'} ${trade.direction ?? ''}`.trim()
  const meta = [
    trade.rr != null ? `RR ${trade.rr}` : null,
    trade.risk_pct != null ? `risque ${trade.risk_pct}%` : null,
    trade.timeframe || null,
  ].filter(Boolean).join(' · ')
  const acc = accounts.find(a => a.id === trade.account_id)
  const accLine = acc ? `\nCompte : ${acc.label}` : ''
  if (breaches.length) {
    const lines = breaches.map(b => `• ${b.message}`).join('\n')
    await sendTelegram(`⚠️ *Trade pris — plan NON respecté*\n${head}${meta ? ' · ' + meta : ''}${accLine}\n${lines}`)
  } else {
    await sendTelegram(`✅ *Trade pris — plan respecté*\n${head}${meta ? ' · ' + meta : ''}${accLine}`)
  }
}

// Notif Telegram a la cloture : gain / perte + solde du compte.
async function notifyTradeClosed(trade) {
  if (!trade || trade.status === 'open') return
  const pnl = Number(trade.pnl_amount) || 0
  const icon = pnl > 0 ? '🟢' : pnl < 0 ? '🔴' : '⚪️'
  const verdict = pnl > 0 ? 'Gain' : pnl < 0 ? 'Perte' : 'Break-even'
  const head = `${trade.symbol ?? '?'} ${trade.direction ?? ''}`.trim()
  const pct = trade.pnl_pct != null ? ` (${trade.pnl_pct}%)` : ''
  const bal = await accountBalanceLive(trade.account_id)
  const balLine = bal ? `\n${bal.label} : ${fmtUsd(bal.balance)}` : ''
  await sendTelegram(`${icon} *${verdict} ${fmtUsd(pnl)}*${pct}\n${head}${balLine}`)
}

// Notif Telegram quand une position s'ouvre (detectee via l'API Myfxbook open-trades).
async function notifyOpenPosition(accountLabel, row) {
  const dir = row.action === 'Sell' ? 'SHORT' : 'LONG'
  const bits = [
    row.openPrice ? `entrée ${row.openPrice}` : null,
    Number(row.sl) ? `SL ${row.sl}` : null,
    Number(row.tp) ? `TP ${row.tp}` : null,
  ].filter(Boolean).join(' · ')
  await sendTelegram(`🔵 *Position ouverte* — ${row.symbol ?? '?'} ${dir}\nCompte : ${accountLabel}${bits ? '\n' + bits : ''}`)
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
    account_id,
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
    account_id: account_id ?? null,
    comment: comment ?? '',
    status: 'open',                       // 'open' | 'win' | 'loss' | 'breakeven'
    result_price: null,
    pnl_pct: null,
    pnl_amount: null,
    closed_at: null,
  }

  await insertTrade(trade)
  broadcast('trade_added', trade)
  syncPlanViolations(trade).catch(err => console.error('[plan]', err.message))
  notifyTradeOpened(trade).catch(err => console.error('[telegram]', err.message))

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
    'account_id',
  ]

  const updates = {}
  editableFields.forEach(field => {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      updates[field] = req.body[field]
    }
  })

  let previous = null
  const updated = await updateTrade(req.params.id, current => {
    previous = current
    return {
      ...current,
      ...updates,
      updated_at: new Date().toISOString(),
      closed_at: updates.status && updates.status !== 'open'
        ? (current.closed_at ?? new Date().toISOString())
        : updates.status === 'open'
          ? null
          : current.closed_at,
    }
  })

  if (!updated) return res.status(404).json({ error: 'not found' })

  broadcast('trade_updated', updated)
  syncPlanViolations(updated).catch(err => console.error('[plan]', err.message))
  if (previous && previous.status === 'open' && updated.status && updated.status !== 'open') {
    notifyTradeClosed(updated).catch(err => console.error('[telegram]', err.message))
  }
  res.json(updated)
})

// DELETE a trade
app.delete('/api/trades/:id', async (req, res) => {
  const deleted = await deleteTrade(req.params.id)
  if (!deleted) return res.status(404).json({ error: 'not found' })

  await deleteViolationsForTrade(req.params.id).catch(err => console.error('[plan]', err.message))
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

// ---------- Accounts API ----------

app.get('/api/accounts', async (req, res) => {
  res.json(await readAccounts())
})

app.put('/api/accounts/:id', async (req, res) => {
  const accounts = await readAccounts()
  const idx = accounts.findIndex(a => a.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: 'not found' })
  const { id: _ignore, ...patch } = req.body
  accounts[idx] = { ...accounts[idx], ...patch, id: accounts[idx].id, updated_at: new Date().toISOString() }
  await writeAccounts(accounts)
  broadcast('accounts_updated', accounts)
  res.json(accounts[idx])
})

// Back-compat: /api/prop-firm still resolves to one account (?account=<id>,
// else the first one) so older callers / the ATM flow keep working.
app.get('/api/prop-firm', async (req, res) => {
  const accounts = await readAccounts()
  res.json(accounts.find(a => a.id === req.query.account) ?? accounts[0] ?? {})
})

app.put('/api/prop-firm', async (req, res) => {
  const accounts = await readAccounts()
  const idx = req.query.account ? accounts.findIndex(a => a.id === req.query.account) : 0
  if (idx === -1) return res.status(404).json({ error: 'account not found' })
  accounts[idx] = { ...accounts[idx], ...req.body, id: accounts[idx].id, updated_at: new Date().toISOString() }
  await writeAccounts(accounts)
  broadcast('accounts_updated', accounts)
  res.json(accounts[idx])
})

// ---------- Trading plan API ----------

app.get('/api/plan', async (req, res) => {
  res.json(await readPlan())
})

app.put('/api/plan', async (req, res) => {
  const next = { ...(await readPlan()), ...req.body, updated_at: new Date().toISOString() }
  await writePlan(next)
  broadcast('plan_updated', next)
  res.json(next)
})

// GET plan violations. Default: only unresolved. ?resolved=true for resolved,
// ?resolved=all for everything.
app.get('/api/violations', async (req, res) => {
  const all = await readViolations()
  const { resolved } = req.query
  if (resolved === 'all') return res.json(all)
  const want = resolved === 'true'
  res.json(all.filter(v => Boolean(v.resolved) === want))
})

// ---------- Telegram ----------

app.get('/api/telegram/status', (req, res) => {
  res.json({
    has_token: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    has_chat_id: Boolean(process.env.TELEGRAM_CHAT_ID),
    configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  })
})

app.post('/api/telegram/test', async (req, res) => {
  const result = await sendTelegram(`🔔 Test — ${new Date().toISOString()}`)
  res.json(result)
})

// ---------- Myfxbook sync (5ers track record) ----------

const MYFXBOOK_SYNC_DEPS = {
  readTrades, insertTrade, readAccounts, writeAccounts, broadcast,
  notifyTradeClosed, notifyOpenPosition, syncPlanViolations, sendTelegram, fmtUsd,
}
// Reglable via MYFXBOOK_SYNC_INTERVAL_MS (defaut 15 min). Plancher a 60 s :
// Myfxbook ne rafraichit ses donnees que toutes les quelques minutes de toute
// facon, et un login/logout par minute est deja beaucoup.
const MYFXBOOK_SYNC_INTERVAL_MS = Math.max(
  60 * 1000,
  Number(process.env.MYFXBOOK_SYNC_INTERVAL_MS) || 15 * 60 * 1000,
)
let myfxbookSyncing = false

async function runMyfxbookSync(trigger) {
  if (myfxbookSyncing) return { skipped: true, reason: 'sync already running' }
  myfxbookSyncing = true
  try {
    const result = await syncMyfxbook(MYFXBOOK_SYNC_DEPS)
    if (!result.skipped) {
      const per = (result.accounts || []).map(a => `${a.account}: ${a.error ? a.error : `+${a.inserted} (${a.balance})`}`).join(' | ')
      console.log(`[myfxbook] ${trigger}: +${result.inserted} trades — ${per}`)
    }
    return result
  } catch (err) {
    console.error(`[myfxbook] ${trigger} failed:`, err.message)
    return { skipped: false, error: err.message }
  } finally {
    myfxbookSyncing = false
  }
}

// Manual trigger for the Myfxbook sync
app.post('/api/myfxbook-sync', async (req, res) => {
  const result = await runMyfxbookSync('manual')
  if (result.error) return res.status(502).json(result)
  res.json(result)
})

// stats endpoint (bonus). ?account=<id> scopes every figure to one account;
// omitted = all accounts combined ("Global").
app.get('/api/stats', async (req, res) => {
  const accountId = req.query.account || null
  const allTrades = await readTrades()
  const trades = accountId ? allTrades.filter(t => t.account_id === accountId) : allTrades
  const closed = trades.filter(t => t.status !== 'open')
  const wins = closed.filter(t => t.status === 'win')
  const longTrades = trades.filter(t => t.direction === 'LONG')
  const shortTrades = trades.filter(t => t.direction === 'SHORT')
  const accounts = await readAccounts()
  const propFirm = accountId
    ? (accounts.find(a => a.id === accountId) ?? {})
    : combineAccounts(accounts)
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
  .then(() => ensureDefaultAccounts())
  .then(() => repairMyfxbookAccountRefs())
  .then(() => backfillTradeAccounts())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`track_record API running on http://localhost:${PORT} (storage: ${pool ? 'postgres' : 'json files'})`)
    })

    // First sync on boot, then every 15 min. No-op if MYFXBOOK_* env vars are unset.
    runMyfxbookSync('startup')
    setInterval(() => runMyfxbookSync('interval'), MYFXBOOK_SYNC_INTERVAL_MS)
  })
  .catch(err => {
    console.error('Failed to initialize database', err)
    process.exit(1)
  })
