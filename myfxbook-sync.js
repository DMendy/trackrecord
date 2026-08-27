import { randomUUID } from 'crypto'

// Pull-based sync from Myfxbook (free "Auto Update" connection). Myfxbook's
// AutoSync already talks to the 5ers MT5 server with the investor password, so
// here we only read what it aggregated: account balance/equity + closed trade
// history. The objective half of a trade fills automatically; the ATM half
// (pillars / note /10) stays null for Claude to fill afterwards.

const API_BASE = 'https://www.myfxbook.com/api'

// Myfxbook returns "Deposit" / "Withdrawal" / "Credit" rows in the history feed
// alongside real fills — only Buy/Sell are trades.
const TRADE_ACTIONS = new Set(['Buy', 'Sell'])

async function callApi(endpoint, params) {
  const url = `${API_BASE}/${endpoint}.json?${new URLSearchParams(params)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Myfxbook ${endpoint} responded ${res.status}`)
  const body = await res.json()
  if (body.error) throw new Error(`Myfxbook ${endpoint}: ${body.message || 'unknown error'}`)
  return body
}

async function login(email, password) {
  const body = await callApi('login', { email, password })
  if (!body.session) throw new Error('Myfxbook login returned no session')
  // Myfxbook returns the session already percent-encoded for raw URL use; decode
  // it so URLSearchParams re-encodes it exactly once on the next call.
  return decodeURIComponent(body.session)
}

// "08/27/2026 18:11" (MM/DD/YYYY HH:MM, Myfxbook profile timezone) -> ISO string.
function parseMyfxbookDate(value) {
  if (!value) return null
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/)
  if (!match) {
    const fallback = new Date(value)
    return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString()
  }
  const [, mm, dd, yyyy, hh, min] = match
  return new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00Z`).toISOString()
}

// Myfxbook history rows carry no id — build a stable key so re-syncs don't
// duplicate trades.
function sourceRef(row) {
  return [
    'myfxbook',
    row.openTime,
    row.closeTime,
    row.symbol,
    row.action,
    row.openPrice,
    row.closePrice,
    row.profit,
  ].join('|')
}

function mapHistoryRow(row, { startingBalance }) {
  const profit = Number(row.profit) || 0
  const commission = Number(row.commission) || 0
  const interest = Number(row.interest) || 0
  const openTime = parseMyfxbookDate(row.openTime)
  const closeTime = parseMyfxbookDate(row.closeTime)
  const sl = Number(row.sl) || 0
  const tp = Number(row.tp) || 0
  const entry = Number(row.openPrice) || null
  const close = Number(row.closePrice) || null

  let rr = null
  if (entry != null && sl > 0) {
    const risk = Math.abs(entry - sl)
    if (risk > 0 && close != null) rr = +(Math.abs(close - entry) / risk * (profit >= 0 ? 1 : -1)).toFixed(2)
  }

  return {
    id: randomUUID(),
    timestamp: openTime ?? new Date().toISOString(),
    symbol: row.symbol || 'UNKNOWN',
    direction: row.action === 'Sell' ? 'SHORT' : 'LONG',
    timeframe: null,
    entry,
    sl: sl > 0 ? sl : null,
    tp1: tp > 0 ? tp : null,
    tp2: null,
    rr,
    note: null,
    pillars: { prix: null, momentum: null, structure: null },
    strategy: 'ATM',
    session: null,
    image_url: '',
    setup: '',
    tags: ['auto', 'myfxbook'],
    fees: commission ? +commission.toFixed(2) : null,
    risk_pct: null,
    position_size: row.sizing?.value ? Number(row.sizing.value) : null,
    prop_firm: true,
    comment: row.comment || '',
    status: profit > 0 ? 'win' : profit < 0 ? 'loss' : 'breakeven',
    result_price: close,
    pnl_pct: startingBalance ? +((profit / startingBalance) * 100).toFixed(3) : null,
    pnl_amount: +(profit + interest).toFixed(2),
    closed_at: closeTime,
    source: 'myfxbook',
    source_ref: sourceRef(row),
  }
}

/**
 * @param {object} deps
 * @param {() => Promise<any[]>} deps.readTrades
 * @param {(trade: any) => Promise<any>} deps.insertTrade
 * @param {() => Promise<any>} deps.readPropFirm
 * @param {(config: any) => Promise<void>} deps.writePropFirm
 * @param {(event: string, data: any) => void} deps.broadcast
 */
export async function syncMyfxbook(deps) {
  const email = process.env.MYFXBOOK_EMAIL
  const password = process.env.MYFXBOOK_PASSWORD
  const accountId = process.env.MYFXBOOK_ACCOUNT_ID

  if (!email || !password || !accountId) {
    return { skipped: true, reason: 'MYFXBOOK_EMAIL / MYFXBOOK_PASSWORD / MYFXBOOK_ACCOUNT_ID not configured' }
  }

  const session = await login(email, password)

  try {
    // 1. Account snapshot -> prop firm balance / drawdown
    const accountsBody = await callApi('get-my-accounts', { session })
    const account = (accountsBody.accounts || []).find(a => String(a.id) === String(accountId))
    if (!account) throw new Error(`Myfxbook account id ${accountId} not found on this login`)

    const propFirm = await readPropFirmSafe(deps)
    const startingBalance = Number(propFirm.starting_balance) || Number(account.deposits) || 200000
    const nextPropFirm = {
      ...propFirm,
      current_balance: +Number(account.balance).toFixed(2),
      equity: +Number(account.equity).toFixed(2),
      gain_pct: Number(account.gain),
      drawdown_pct: Number(account.drawdown),
      last_sync: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    // 2. Closed trades
    const historyBody = await callApi('get-history', { session, id: accountId })
    const rows = (historyBody.history || []).filter(r => TRADE_ACTIONS.has(r.action))

    const existing = await deps.readTrades()
    const priorPropFirmCount = existing.filter(t => t.prop_firm).length
    const knownRefs = new Set(existing.map(t => t.source_ref).filter(Boolean))

    const inserted = []
    // Myfxbook returns newest-first; insert oldest-first so equity curve order is stable.
    for (const row of [...rows].reverse()) {
      const ref = sourceRef(row)
      if (knownRefs.has(ref)) continue
      const trade = mapHistoryRow(row, { startingBalance })
      await deps.insertTrade(trade)
      deps.broadcast('trade_added', trade)
      inserted.push(trade)
      knownRefs.add(ref)
    }

    nextPropFirm.trades_taken = priorPropFirmCount + inserted.length
    await deps.writePropFirm(nextPropFirm)
    deps.broadcast('prop_firm_updated', nextPropFirm)

    return {
      skipped: false,
      account: account.name,
      balance: nextPropFirm.current_balance,
      history_rows: rows.length,
      inserted: inserted.length,
      last_sync: nextPropFirm.last_sync,
    }
  } finally {
    // best-effort logout so sessions don't pile up
    try {
      await callApi('logout', { session })
    } catch {
      /* ignore */
    }
  }
}

async function readPropFirmSafe(deps) {
  try {
    return (await deps.readPropFirm()) ?? {}
  } catch {
    return {}
  }
}
