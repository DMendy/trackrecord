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
// duplicate trades. The account id is part of the key so the same fill copied
// across two prop-firm accounts stays two distinct trades.
function sourceRef(row, accountId) {
  return [
    'myfxbook',
    accountId ?? '',
    row.openTime,
    row.closeTime,
    row.symbol,
    row.action,
    row.openPrice,
    row.closePrice,
    row.profit,
  ].join('|')
}

function mapHistoryRow(row, { startingBalance, accountId }) {
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
    account_id: accountId ?? null,
    comment: row.comment || '',
    status: profit > 0 ? 'win' : profit < 0 ? 'loss' : 'breakeven',
    result_price: close,
    pnl_pct: startingBalance ? +((profit / startingBalance) * 100).toFixed(3) : null,
    pnl_amount: +(profit + interest).toFixed(2),
    closed_at: closeTime,
    source: 'myfxbook',
    source_ref: sourceRef(row, accountId),
  }
}

/**
 * @param {object} deps
 * @param {() => Promise<any[]>} deps.readTrades
 * @param {(trade: any) => Promise<any>} deps.insertTrade
 * @param {() => Promise<any[]>} deps.readAccounts
 * @param {(list: any[]) => Promise<void>} deps.writeAccounts
 * @param {(event: string, data: any) => void} deps.broadcast
 */
export async function syncMyfxbook(deps) {
  const email = process.env.MYFXBOOK_EMAIL
  const password = process.env.MYFXBOOK_PASSWORD

  if (!email || !password) {
    return { skipped: true, reason: 'MYFXBOOK_EMAIL / MYFXBOOK_PASSWORD not configured' }
  }

  const accounts = await deps.readAccounts()
  const synced = accounts.filter(a => a.myfxbook_account_id)
  if (!synced.length) {
    return { skipped: true, reason: 'no account has a myfxbook_account_id' }
  }

  const session = await login(email, password)

  try {
    const accountsBody = await callApi('get-my-accounts', { session })
    const remote = accountsBody.accounts || []

    const existing = await deps.readTrades()
    const knownRefs = new Set(existing.map(t => t.source_ref).filter(Boolean))
    const nextAccounts = accounts.map(a => ({ ...a }))
    const results = []
    let totalInserted = 0

    for (const acc of synced) {
      const match = remote.find(r => String(r.id) === String(acc.myfxbook_account_id))
      if (!match) {
        results.push({ account: acc.label, error: `id ${acc.myfxbook_account_id} not found on this login` })
        continue
      }

      const startingBalance = Number(acc.starting_balance) || Number(match.deposits) || Number(acc.account_size) || 200000

      // Myfxbook returns newest-first; insert oldest-first so the equity curve stays ordered.
      const historyBody = await callApi('get-history', { session, id: acc.myfxbook_account_id })
      const rows = (historyBody.history || []).filter(r => TRADE_ACTIONS.has(r.action))

      let inserted = 0
      for (const row of [...rows].reverse()) {
        const ref = sourceRef(row, acc.id)
        if (knownRefs.has(ref)) continue
        const trade = mapHistoryRow(row, { startingBalance, accountId: acc.id })
        await deps.insertTrade(trade)
        deps.broadcast('trade_added', trade)
        knownRefs.add(ref)
        inserted += 1
      }
      totalInserted += inserted

      const idx = nextAccounts.findIndex(a => a.id === acc.id)
      const priorCount = existing.filter(t => t.account_id === acc.id).length
      nextAccounts[idx] = {
        ...nextAccounts[idx],
        current_balance: +Number(match.balance).toFixed(2),
        equity: +Number(match.equity).toFixed(2),
        gain_pct: Number(match.gain),
        drawdown_pct: Number(match.drawdown),
        trades_taken: priorCount + inserted,
        last_sync: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      results.push({ account: acc.label, balance: nextAccounts[idx].current_balance, history_rows: rows.length, inserted })
    }

    await deps.writeAccounts(nextAccounts)
    deps.broadcast('accounts_updated', nextAccounts)

    return {
      skipped: false,
      accounts: results,
      inserted: totalInserted,
      last_sync: new Date().toISOString(),
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
