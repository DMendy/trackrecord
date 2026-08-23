import { createApp } from 'vue'

const DEFAULT_API_URL = 'https://vibrant-quietude-production-374a.up.railway.app'
const API = import.meta.env.VITE_API_URL
  ?? (window.TRACK_RECORD_API_URL
    ?? (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? '' : DEFAULT_API_URL))

function apiUrl(path) {
  return `${API}${path}`
}

function assetUrl(path) {
  if (!path || path.startsWith('http') || path.startsWith('data:')) return path
  return `${API}${path}`
}

const blankTrade = () => ({
  symbol: '',
  direction: 'LONG',
  timeframe: '4H',
  strategy: 'ATM',
  session: 'London',
  entry: null,
  sl: null,
  tp1: null,
  tp2: null,
  rr: null,
  note: null,
  status: 'open',
  result_price: null,
  pnl_pct: null,
  pnl_amount: null,
  risk_pct: null,
  position_size: null,
  image_url: '',
  setup: '',
  comment: '',
  tags: [],
  prop_firm: true,
  pillars: {
    prix: null,
    momentum: null,
    structure: null,
  },
})

createApp({
  data() {
    return {
      trades: [],
      stats: {},
      propFirm: {},
      query: '',
      statusFilter: 'all',
      directionFilter: 'all',
      editorOpen: false,
      editingId: null,
      form: blankTrade(),
      saving: false,
      calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
      calendarAuto: true,
    }
  },

  computed: {
    filteredTrades() {
      const q = this.query.trim().toLowerCase()
      return this.trades
        .filter(trade => this.statusFilter === 'all' || trade.status === this.statusFilter)
        .filter(trade => this.directionFilter === 'all' || trade.direction === this.directionFilter)
        .filter(trade => {
          if (!q) return true
          return [trade.symbol, trade.strategy, trade.session, trade.comment, trade.setup]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(q)
        })
        .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
    },

    galleryTrades() {
      return this.filteredTrades.slice(0, 8)
    },

    pairStats() {
      const counts = this.countBy('symbol')
      return this.topBars(counts, 6)
    },

    rrStats() {
      const buckets = { '<1R': 0, '1-2R': 0, '2-3R': 0, '3R+': 0 }
      this.trades.forEach(trade => {
        const rr = Number(trade.rr)
        if (!Number.isFinite(rr)) return
        if (rr < 1) buckets['<1R'] += 1
        else if (rr < 2) buckets['1-2R'] += 1
        else if (rr < 3) buckets['2-3R'] += 1
        else buckets['3R+'] += 1
      })
      return this.topBars(buckets, 4)
    },

    closedTradesByDate() {
      return this.trades
        .filter(trade => trade.status !== 'open')
        .slice()
        .sort((a, b) => new Date(a.closed_at || a.timestamp || 0) - new Date(b.closed_at || b.timestamp || 0))
    },

    equitySeries() {
      let running = 0
      return this.closedTradesByDate.map(trade => {
        running += Number(trade.pnl_amount) || 0
        return running
      })
    },

    equityTotal() {
      const series = this.equitySeries
      return series.length ? series[series.length - 1] : 0
    },

    equityPath() {
      const series = this.equitySeries
      if (series.length < 2) return ''
      const min = Math.min(0, ...series)
      const max = Math.max(0, ...series)
      const range = max - min || 1
      const stepX = 100 / (series.length - 1)
      return series
        .map((value, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(2)},${(100 - ((value - min) / range) * 100).toFixed(2)}`)
        .join(' ')
    },

    equityAreaPath() {
      if (!this.equityPath) return ''
      return `${this.equityPath} L100,100 L0,100 Z`
    },

    equityZeroY() {
      const series = this.equitySeries
      if (series.length < 2) return null
      const min = Math.min(0, ...series)
      const max = Math.max(0, ...series)
      const range = max - min || 1
      if (min > 0 || max < 0) return null
      return 100 - ((0 - min) / range) * 100
    },

    dailyPnl() {
      const map = {}
      this.trades.forEach(trade => {
        if (trade.status === 'open') return
        const dateKey = (trade.closed_at || trade.timestamp || '').slice(0, 10)
        if (!dateKey) return
        if (!map[dateKey]) map[dateKey] = { pnl: 0, trades: 0, wins: 0 }
        map[dateKey].pnl += Number(trade.pnl_amount) || 0
        map[dateKey].trades += 1
        if (trade.status === 'win') map[dateKey].wins += 1
      })
      return map
    },

    calendarWeeks() {
      const year = this.calendarMonth.getFullYear()
      const month = this.calendarMonth.getMonth()
      const firstDay = new Date(year, month, 1)
      const startOffset = (firstDay.getDay() + 6) % 7
      const daysInMonth = new Date(year, month + 1, 0).getDate()

      const cells = []
      for (let i = 0; i < startOffset; i += 1) cells.push(null)
      for (let day = 1; day <= daysInMonth; day += 1) {
        const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        const info = this.dailyPnl[dateKey]
        cells.push({ day, pnl: info ? info.pnl : 0, trades: info ? info.trades : 0 })
      }
      while (cells.length % 7 !== 0) cells.push(null)

      const weeks = []
      for (let i = 0; i < cells.length; i += 7) {
        const weekCells = cells.slice(i, i + 7)
        const hasData = weekCells.some(cell => cell && cell.trades)
        const total = weekCells.reduce((sum, cell) => sum + (cell ? cell.pnl : 0), 0)
        weeks.push({ cells: weekCells, total, hasData })
      }
      return weeks
    },

    calendarLabel() {
      return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(this.calendarMonth)
    },

    monthStats() {
      const year = this.calendarMonth.getFullYear()
      const month = this.calendarMonth.getMonth()
      const prefix = `${year}-${String(month + 1).padStart(2, '0')}`
      const entries = Object.entries(this.dailyPnl).filter(([key]) => key.startsWith(prefix))
      const trades = entries.reduce((sum, [, v]) => sum + v.trades, 0)
      const wins = entries.reduce((sum, [, v]) => sum + v.wins, 0)
      const pnl = entries.reduce((sum, [, v]) => sum + v.pnl, 0)
      return {
        trades,
        winRate: trades ? Math.round((wins / trades) * 100) : 0,
        pnl,
      }
    },

    pfProgress() {
      const start = Number(this.propFirm.starting_balance) || 100000
      const current = Number(this.propFirm.current_balance) || start
      const target = Number(this.propFirm.profit_target) || 1
      const maxDd = Number(this.propFirm.max_total_drawdown) || 1
      const profit = current - start
      const drawdown = Math.max(0, start - current)
      return {
        profit,
        targetPct: Math.min(100, Math.max(0, (profit / target) * 100)),
        drawdownPct: Math.min(100, Math.max(0, (drawdown / maxDd) * 100)),
      }
    },
  },

  mounted() {
    this.load()
    this.connectStream()
  },

  methods: {
    async load() {
      const [trades, stats, propFirm] = await Promise.all([
        fetch(apiUrl('/api/trades')).then(r => r.json()),
        fetch(apiUrl('/api/stats')).then(r => r.json()),
        fetch(apiUrl('/api/prop-firm')).then(r => r.json()),
      ])
      this.trades = trades
      this.stats = stats
      this.propFirm = propFirm
      this.focusLatestTradeMonth()
    },

    connectStream() {
      const stream = new EventSource(apiUrl('/api/stream'))
      stream.addEventListener('init', event => {
        this.trades = JSON.parse(event.data)
        this.refreshStats()
        this.focusLatestTradeMonth()
      })
      stream.addEventListener('trade_added', event => {
        this.trades = [JSON.parse(event.data), ...this.trades]
        this.refreshStats()
      })
      stream.addEventListener('trade_updated', event => {
        const next = JSON.parse(event.data)
        this.trades = this.trades.map(trade => trade.id === next.id ? next : trade)
        this.refreshStats()
      })
      stream.addEventListener('trade_deleted', event => {
        const next = JSON.parse(event.data)
        this.trades = this.trades.filter(trade => trade.id !== next.id)
        this.refreshStats()
      })
      stream.addEventListener('prop_firm_updated', event => {
        this.propFirm = JSON.parse(event.data)
      })
    },

    async refreshStats() {
      this.stats = await fetch(apiUrl('/api/stats')).then(r => r.json())
    },

    countBy(field) {
      return this.trades.reduce((acc, trade) => {
        const key = trade[field] || 'Non defini'
        acc[key] = (acc[key] || 0) + 1
        return acc
      }, {})
    },

    topBars(counts, limit) {
      const max = Math.max(1, ...Object.values(counts))
      return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([label, value]) => ({ label, value, pct: Math.round((value / max) * 100) }))
    },

    shiftMonth(delta) {
      this.calendarAuto = false
      this.calendarMonth = new Date(this.calendarMonth.getFullYear(), this.calendarMonth.getMonth() + delta, 1)
    },

    focusLatestTradeMonth() {
      if (!this.calendarAuto || !this.trades.length) return
      const latest = this.trades.reduce((max, trade) => {
        const date = new Date(trade.closed_at || trade.timestamp || 0)
        return date > max ? date : max
      }, new Date(0))
      if (latest.getTime() > 0) {
        this.calendarMonth = new Date(latest.getFullYear(), latest.getMonth(), 1)
      }
    },

    openNew() {
      this.editingId = null
      this.form = blankTrade()
      this.editorOpen = true
    },

    editTrade(trade) {
      this.editingId = trade.id
      this.form = {
        ...blankTrade(),
        ...JSON.parse(JSON.stringify(trade)),
        pillars: {
          ...blankTrade().pillars,
          ...(trade.pillars || {}),
        },
      }
      this.editorOpen = true
    },

    async saveTrade() {
      this.saving = true
      const payload = {
        ...this.form,
        entry: this.toNumber(this.form.entry),
        sl: this.toNumber(this.form.sl),
        tp1: this.toNumber(this.form.tp1),
        tp2: this.toNumber(this.form.tp2),
        rr: this.toNumber(this.form.rr),
        note: this.toNumber(this.form.note),
        result_price: this.toNumber(this.form.result_price),
        pnl_pct: this.toNumber(this.form.pnl_pct),
        pnl_amount: this.toNumber(this.form.pnl_amount),
        risk_pct: this.toNumber(this.form.risk_pct),
        position_size: this.toNumber(this.form.position_size),
      }

      const url = this.editingId ? apiUrl(`/api/trades/${this.editingId}`) : apiUrl('/api/trades')
      const method = this.editingId ? 'PATCH' : 'POST'
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (response.ok) {
        this.editorOpen = false
        await this.load()
      }
      this.saving = false
    },

    async deleteTrade(trade) {
      await fetch(apiUrl(`/api/trades/${trade.id}`), { method: 'DELETE' })
      await this.load()
    },

    async savePropFirm() {
      const response = await fetch(apiUrl('/api/prop-firm'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.propFirm),
      })
      this.propFirm = await response.json()
      await this.refreshStats()
    },

    async uploadImage(event) {
      const file = event.target.files?.[0]
      if (!file) return
      const dataUrl = await new Promise(resolve => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.readAsDataURL(file)
      })
      const response = await fetch(apiUrl('/api/uploads'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, data_url: dataUrl }),
      })
      const result = await response.json()
      this.form.image_url = result.image_url
    },

    toNumber(value) {
      if (value === '' || value === null || value === undefined) return null
      const number = Number(value)
      return Number.isFinite(number) ? number : null
    },

    formatDate(value) {
      if (!value) return '-'
      return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value))
    },

    money(value) {
      return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(value) || 0)
    },

    assetUrl,
  },

  template: `
    <main class="app">
      <header class="topbar">
        <div class="brand">
          <div class="logo">TJ</div>
          <div>
            <h1>Trading Journal</h1>
            <p class="subtitle">ATM · Track record · Prop firm 100K</p>
          </div>
        </div>
        <div class="top-actions">
          <span class="status-pill"><span class="live-dot"></span>Live</span>
          <button class="btn ghost" @click="load">Refresh</button>
          <button class="btn primary" @click="openNew">+ Trade</button>
        </div>
      </header>

      <div class="layout">
        <section class="stats">
          <div class="metric tone-blue">
            <span class="metric-icon">#</span>
            <div class="metric-body"><p class="label">Trades</p><div class="value">{{ stats.total || 0 }}</div></div>
          </div>
          <div class="metric tone-amber">
            <span class="metric-icon">○</span>
            <div class="metric-body"><p class="label">Ouverts</p><div class="value">{{ stats.open || 0 }}</div></div>
          </div>
          <div class="metric tone-green">
            <span class="metric-icon">%</span>
            <div class="metric-body"><p class="label">Win rate</p><div class="value good">{{ stats.win_rate ?? 0 }}%</div></div>
          </div>
          <div class="metric tone-violet">
            <span class="metric-icon">R</span>
            <div class="metric-body"><p class="label">Avg RR</p><div class="value">{{ stats.avg_rr ?? 0 }}R</div></div>
          </div>
          <div class="metric tone-pnl" :class="{ good: (stats.avg_pnl_pct || 0) >= 0, bad: (stats.avg_pnl_pct || 0) < 0 }">
            <span class="metric-icon">±</span>
            <div class="metric-body"><p class="label">PnL moyen</p><div class="value" :class="{ good: (stats.avg_pnl_pct || 0) >= 0, bad: (stats.avg_pnl_pct || 0) < 0 }">{{ stats.avg_pnl_pct ?? 0 }}%</div></div>
          </div>
          <div class="metric tone-teal">
            <span class="metric-icon">$</span>
            <div class="metric-body"><p class="label">Balance PF</p><div class="value">{{ money(propFirm.current_balance) }}</div></div>
            <svg v-if="equitySeries.length > 1" class="metric-spark" viewBox="0 0 100 100" preserveAspectRatio="none">
              <path :d="equityAreaPath" class="equity-area" />
              <path :d="equityPath" class="equity-line" :class="{ good: equityTotal >= 0, bad: equityTotal < 0 }" />
            </svg>
          </div>
        </section>

        <section>
          <div class="section-head">
            <h2>Derniers trades</h2>
            <div class="filters">
              <input class="field" v-model="query" placeholder="Search pair, setup, session" />
              <select class="select" v-model="statusFilter">
                <option value="all">All status</option>
                <option value="open">Open</option>
                <option value="win">Win</option>
                <option value="loss">Loss</option>
                <option value="breakeven">BE</option>
              </select>
              <select class="select" v-model="directionFilter">
                <option value="all">Long + Short</option>
                <option value="LONG">Long</option>
                <option value="SHORT">Short</option>
              </select>
            </div>
          </div>
          <div v-if="galleryTrades.length" class="gallery">
            <article v-for="trade in galleryTrades" :key="trade.id" class="trade-card" @click="editTrade(trade)">
              <div class="shot">
                <img v-if="trade.image_url" :src="assetUrl(trade.image_url)" :alt="trade.symbol" />
                <span v-else>No chart</span>
              </div>
              <div class="card-body">
                <div class="card-line">
                  <span class="pair">{{ trade.symbol || 'UNKNOWN' }}</span>
                  <span class="badge" :class="trade.direction?.toLowerCase()">{{ trade.direction }}</span>
                </div>
                <div class="row-between" style="margin-top: 10px;">
                  <span class="badge">{{ trade.strategy || 'ATM' }}</span>
                  <span class="label">{{ formatDate(trade.timestamp) }}</span>
                  <span class="badge">{{ trade.rr ?? '-' }}R</span>
                </div>
              </div>
            </article>
          </div>
          <div v-else class="empty">Aucun trade pour le moment</div>
        </section>

        <section class="panel">
          <div class="section-head">
            <h2>Historique complet</h2>
            <span class="label">{{ filteredTrades.length }} lignes</span>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Pair</th><th>Outcome</th><th>Date</th><th>Position</th><th>TF</th><th>Strategy</th><th>Session</th>
                  <th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>RR</th><th>Note</th><th>PnL %</th><th>PnL $</th><th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="trade in filteredTrades" :key="trade.id">
                  <td><strong>{{ trade.symbol }}</strong></td>
                  <td><span class="badge" :class="trade.status">{{ trade.status }}</span></td>
                  <td>{{ formatDate(trade.timestamp) }}</td>
                  <td><span class="badge" :class="trade.direction?.toLowerCase()">{{ trade.direction }}</span></td>
                  <td>{{ trade.timeframe }}</td>
                  <td>{{ trade.strategy || 'ATM' }}</td>
                  <td>{{ trade.session || '-' }}</td>
                  <td>{{ trade.entry ?? '-' }}</td>
                  <td>{{ trade.sl ?? '-' }}</td>
                  <td>{{ trade.tp1 ?? '-' }}</td>
                  <td>{{ trade.tp2 ?? '-' }}</td>
                  <td>{{ trade.rr ?? '-' }}</td>
                  <td>{{ trade.note ?? '-' }}</td>
                  <td>{{ trade.pnl_pct ?? '-' }}</td>
                  <td>{{ trade.pnl_amount ?? '-' }}</td>
                  <td>
                    <div class="actions">
                      <button class="icon-btn" title="Modifier" @click="editTrade(trade)">✎</button>
                      <button class="icon-btn" title="Supprimer" @click="deleteTrade(trade)">×</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel">
          <div class="section-head calendar-head">
            <h2>Calendrier des trades</h2>
            <div class="calendar-nav">
              <button type="button" class="icon-btn" @click="shiftMonth(-1)">‹</button>
              <span class="calendar-label">{{ calendarLabel }}</span>
              <button type="button" class="icon-btn" @click="shiftMonth(1)">›</button>
            </div>
          </div>
          <div class="calendar-scroll">
            <div class="calendar-grid">
              <div v-for="d in ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim']" :key="d" class="calendar-weekday">{{ d }}</div>
              <div class="calendar-weekday total">Total</div>
              <template v-for="(week, wi) in calendarWeeks" :key="wi">
                <div
                  v-for="(cell, ci) in week.cells"
                  :key="ci"
                  class="calendar-cell"
                  :class="cell ? (cell.trades ? (cell.pnl >= 0 ? 'win has-data' : 'loss has-data') : '') : 'empty'"
                >
                  <template v-if="cell">
                    <span class="calendar-day">{{ cell.day }}</span>
                    <span v-if="cell.trades" class="calendar-pnl">{{ money(cell.pnl) }}</span>
                    <span v-if="cell.trades" class="calendar-trades">{{ cell.trades }} trade{{ cell.trades > 1 ? 's' : '' }}</span>
                  </template>
                </div>
                <div class="calendar-total" :class="{ good: week.total > 0, bad: week.total < 0 }">{{ week.hasData ? money(week.total) : '—' }}</div>
              </template>
            </div>
          </div>
          <div class="calendar-footer">
            <div class="calendar-stat tone-blue"><span class="label">Trades ce mois</span><strong>{{ monthStats.trades }}</strong></div>
            <div class="calendar-stat tone-violet"><span class="label">Win rate</span><strong>{{ monthStats.winRate }}%</strong></div>
            <div class="calendar-stat tone-pnl" :class="{ good: monthStats.pnl >= 0, bad: monthStats.pnl < 0 }"><span class="label">PnL du mois</span><strong :class="{ good: monthStats.pnl >= 0, bad: monthStats.pnl < 0 }">{{ money(monthStats.pnl) }}</strong></div>
          </div>
        </section>

        <section class="analytics">
          <article class="panel chart">
            <div class="section-head">
              <h2>Performance cumulée</h2>
              <span class="equity-total" :class="{ good: equityTotal >= 0, bad: equityTotal < 0 }">{{ money(equityTotal) }}</span>
            </div>
            <svg v-if="equitySeries.length > 1" class="equity-chart" viewBox="0 0 100 100" preserveAspectRatio="none">
              <line v-if="equityZeroY !== null" x1="0" :y1="equityZeroY" x2="100" :y2="equityZeroY" class="equity-zero" />
              <path :d="equityAreaPath" class="equity-area" />
              <path :d="equityPath" class="equity-line" :class="{ good: equityTotal >= 0, bad: equityTotal < 0 }" />
            </svg>
            <div v-else class="empty">Pas assez de trades clôturés</div>
          </article>

          <article class="panel chart">
            <div class="section-head"><h2>Paires les plus tradées</h2></div>
            <div class="bars">
              <div v-for="item in pairStats" :key="item.label" class="bar-label">
                <span>{{ item.label }}</span><div class="bar-track"><div class="bar-fill blue" :style="{ width: item.pct + '%' }"></div></div><strong>{{ item.value }}</strong>
              </div>
            </div>
          </article>

          <article class="panel chart">
            <div class="section-head"><h2>Distribution RR</h2></div>
            <div class="bars">
              <div v-for="item in rrStats" :key="item.label" class="bar-label">
                <span>{{ item.label }}</span><div class="bar-track"><div class="bar-fill violet" :style="{ width: item.pct + '%' }"></div></div><strong>{{ item.value }}</strong>
              </div>
            </div>
          </article>
        </section>

        <section class="panel">
          <div class="section-head">
            <h2>Prop Firm 100K</h2>
            <button class="btn" @click="savePropFirm">Save PF</button>
          </div>
          <div class="pf-grid">
            <label><span class="label">Provider</span><input class="field" v-model="propFirm.provider" /></label>
            <label><span class="label">Phase</span><input class="field" v-model="propFirm.phase" /></label>
            <label><span class="label">Starting balance</span><input class="field" type="number" v-model="propFirm.starting_balance" /></label>
            <label><span class="label">Current balance</span><input class="field" type="number" v-model="propFirm.current_balance" /></label>
            <label><span class="label">Profit target</span><input class="field" type="number" v-model="propFirm.profit_target" /></label>
            <label><span class="label">Max total DD</span><input class="field" type="number" v-model="propFirm.max_total_drawdown" /></label>
          </div>
          <div style="display: grid; gap: 10px; margin-top: 14px;">
            <div><div class="row-between"><span class="label">Target</span><strong>{{ Math.round(pfProgress.targetPct) }}%</strong></div><div class="progress"><span :style="{ width: pfProgress.targetPct + '%' }"></span></div></div>
            <div><div class="row-between"><span class="label">Drawdown utilisé</span><strong>{{ Math.round(pfProgress.drawdownPct) }}%</strong></div><div class="progress risk"><span :style="{ width: pfProgress.drawdownPct + '%' }"></span></div></div>
          </div>
        </section>
      </div>

      <div v-if="editorOpen" class="drawer">
        <div @click="editorOpen = false"></div>
        <form class="drawer-form" @submit.prevent="saveTrade">
          <div class="section-head">
            <h2>{{ editingId ? 'Modifier Trade' : 'Nouveau Trade' }}</h2>
            <button type="button" class="icon-btn" @click="editorOpen = false">×</button>
          </div>
          <div class="form-section">
            <p class="form-section-title">Trade</p>
            <div class="form-grid">
              <label><span class="label">Pair</span><input class="field" v-model="form.symbol" required /></label>
              <label><span class="label">Status</span><select class="select" v-model="form.status"><option>open</option><option>win</option><option>loss</option><option>breakeven</option></select></label>
              <label><span class="label">Direction</span><select class="select" v-model="form.direction"><option>LONG</option><option>SHORT</option></select></label>
              <label><span class="label">Timeframe</span><input class="field" v-model="form.timeframe" /></label>
              <label><span class="label">Strategy</span><input class="field" v-model="form.strategy" /></label>
              <label><span class="label">Session</span><select class="select" v-model="form.session"><option>Asia</option><option>London</option><option>New York</option><option>Other</option></select></label>
            </div>
          </div>

          <div class="form-section">
            <p class="form-section-title">Niveaux &amp; risque</p>
            <div class="form-grid">
              <label><span class="label">Entry</span><input class="field" type="number" step="any" v-model="form.entry" /></label>
              <label><span class="label">SL</span><input class="field" type="number" step="any" v-model="form.sl" /></label>
              <label><span class="label">TP1</span><input class="field" type="number" step="any" v-model="form.tp1" /></label>
              <label><span class="label">TP2</span><input class="field" type="number" step="any" v-model="form.tp2" /></label>
              <label><span class="label">RR</span><input class="field" type="number" step="any" v-model="form.rr" /></label>
              <label><span class="label">Note /10</span><input class="field" type="number" step="any" v-model="form.note" /></label>
              <label><span class="label">PnL %</span><input class="field" type="number" step="any" v-model="form.pnl_pct" /></label>
              <label><span class="label">PnL $</span><input class="field" type="number" step="any" v-model="form.pnl_amount" /></label>
              <label><span class="label">Risk %</span><input class="field" type="number" step="any" v-model="form.risk_pct" /></label>
              <label><span class="label">Position size</span><input class="field" type="number" step="any" v-model="form.position_size" /></label>
            </div>
          </div>

          <div class="form-section">
            <p class="form-section-title">Piliers ATM</p>
            <div class="form-grid">
              <label><span class="label">Prix</span><input class="field" v-model="form.pillars.prix" /></label>
              <label><span class="label">Momentum</span><input class="field" v-model="form.pillars.momentum" /></label>
              <label><span class="label">Structure</span><input class="field" v-model="form.pillars.structure" /></label>
              <label><span class="label">Prop firm</span><select class="select" v-model="form.prop_firm"><option :value="true">Oui</option><option :value="false">Non</option></select></label>
            </div>
          </div>

          <div class="form-section">
            <p class="form-section-title">Chart &amp; notes</p>
            <div class="form-grid">
              <label class="wide"><span class="label">Image URL</span><input class="field" v-model="form.image_url" /></label>
              <label class="wide"><span class="label">Upload chart</span><input class="field" type="file" accept="image/*" @change="uploadImage" /></label>
              <div v-if="form.image_url" class="preview wide"><img :src="assetUrl(form.image_url)" /></div>
              <label class="wide"><span class="label">Setup</span><textarea class="textarea" v-model="form.setup"></textarea></label>
              <label class="wide"><span class="label">Comment</span><textarea class="textarea" v-model="form.comment"></textarea></label>
            </div>
          </div>
          <div class="top-actions" style="margin-top: 16px;">
            <button class="btn primary" type="submit">{{ saving ? 'Saving...' : 'Save trade' }}</button>
            <button class="btn ghost" type="button" @click="editorOpen = false">Cancel</button>
          </div>
        </form>
      </div>
    </main>
  `,
}).mount('#app')
