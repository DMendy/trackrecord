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

// Ref stable pour une position ouverte (pas d'id cote Myfxbook non plus).
function openRef(accountId, row) {
  return ['open', accountId ?? '', row.openTime, row.symbol, row.action, row.openPrice].join('|')
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
    const available = remote.map(r => ({ id: r.id, name: r.name, balance: r.balance }))

    const existing = await deps.readTrades()
    const knownRefs = new Set(existing.map(t => t.source_ref).filter(Boolean))
    const nextAccounts = accounts.map(a => ({ ...a }))
    const results = []
    let totalInserted = 0
    // Sur le tout premier sync, tout l'historique arrive d'un coup : on
    // enregistre en silence (pas de notif).
    const firstEver = existing.length === 0

    for (const acc of synced) {
      const match = remote.find(r => String(r.id) === String(acc.myfxbook_account_id))
      if (!match) {
        results.push({ account: acc.label, error: `id ${acc.myfxbook_account_id} not found on this login` })
        continue
      }

      const idx = nextAccounts.findIndex(a => a.id === acc.id)
      const startingBalance = Number(acc.starting_balance) || Number(match.deposits) || Number(acc.account_size) || 200000

      // ---- Trades clotures (historique) ----
      // Myfxbook renvoie du plus recent au plus ancien ; on insere l'inverse
      // pour garder la courbe d'equity ordonnee.
      const historyBody = await callApi('get-history', { session, id: acc.myfxbook_account_id })
      const rows = (historyBody.history || []).filter(r => TRADE_ACTIONS.has(r.action))

      const insertedTrades = []
      for (const row of [...rows].reverse()) {
        const ref = sourceRef(row, acc.id)
        if (knownRefs.has(ref)) continue
        const trade = mapHistoryRow(row, { startingBalance, accountId: acc.id })
        await deps.insertTrade(trade)
        deps.broadcast('trade_added', trade)
        knownRefs.add(ref)
        insertedTrades.push(trade)
      }
      totalInserted += insertedTrades.length

      const priorCount = existing.filter(t => t.account_id === acc.id).length
      nextAccounts[idx] = {
        ...nextAccounts[idx],
        current_balance: +Number(match.balance).toFixed(2),
        equity: +Number(match.equity).toFixed(2),
        gain_pct: Number(match.gain),
        drawdown_pct: Number(match.drawdown),
        trades_taken: priorCount + insertedTrades.length,
        last_sync: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      // Check du plan sur les trades fraichement importes (attrape le "2+/jour/compte").
      const freshBreaches = []
      if (!firstEver && deps.syncPlanViolations) {
        for (const t of insertedTrades) {
          try {
            const b = await deps.syncPlanViolations(t)
            if (Array.isArray(b)) freshBreaches.push(...b.map(x => x.message))
          } catch { /* ignore */ }
        }
      }

      // Notif cloture : une par trade si petit lot, un resume si gros rattrapage.
      if (!firstEver && insertedTrades.length && deps.notifyTradeClosed) {
        if (insertedTrades.length <= 3) {
          for (const t of insertedTrades) deps.notifyTradeClosed(t).catch(() => {})
        } else if (deps.sendTelegram) {
          const sum = insertedTrades.reduce((s, t) => s + (Number(t.pnl_amount) || 0), 0)
          const money = deps.fmtUsd ? deps.fmtUsd(sum) : String(sum)
          deps.sendTelegram(`📥 *${insertedTrades.length} trades importés* — ${acc.label}\nPnL total : ${money}`).catch(() => {})
        }
      }
      if (freshBreaches.length && deps.sendTelegram) {
        const uniq = [...new Set(freshBreaches)].map(m => `• ${m}`).join('\n')
        deps.sendTelegram(`⚠️ *Plan non respecté* — ${acc.label}\n${uniq}`).catch(() => {})
      }

      // ---- Positions ouvertes ----
      const openInfo = { count: 0, new: 0 }
      try {
        const openBody = await callApi('get-open-trades', { session, id: acc.myfxbook_account_id })
        const openRows = (openBody.openTrades || []).filter(r => TRADE_ACTIONS.has(r.action))
        const currentRefs = openRows.map(r => openRef(acc.id, r))
        openInfo.count = currentRefs.length
        const prev = Array.isArray(acc.open_refs) ? new Set(acc.open_refs) : null // null = jamais suivi
        if (prev && !firstEver && deps.notifyOpenPosition) {
          for (const r of openRows) {
            if (prev.has(openRef(acc.id, r))) continue
            openInfo.new += 1
            deps.notifyOpenPosition(acc.label, r).catch(() => {})
          }
        }
        nextAccounts[idx].open_refs = currentRefs
      } catch (err) {
        openInfo.error = err.message
      }

      results.push({
        account: acc.label,
        balance: nextAccounts[idx].current_balance,
        history_rows: rows.length,
        inserted: insertedTrades.length,
        open: openInfo,
      })
    }

    await deps.writeAccounts(nextAccounts)
    deps.broadcast('accounts_updated', nextAccounts)

    return {
      skipped: false,
      accounts: results,
      available, // every account id/name Myfxbook exposes on this login
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
