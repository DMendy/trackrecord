import { createApp } from 'vue'
import * as THREE from 'three'

const DEFAULT_API_URL = 'https://trackrecord-kbo7.onrender.com'
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

function readStoredAccount() {
  try {
    return window.localStorage.getItem('trackrecord.account') || ''
  } catch {
    return ''
  }
}

function mountPlanet(container) {
  if (!container) return () => {}
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-3, 3, 2, -2, 0.1, 100)
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true })
  const clock = new THREE.Clock()
  const group = new THREE.Group()
  let frameId

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x000000, 0)
  container.appendChild(renderer.domElement)

  camera.position.set(0, 0, 10)
  scene.add(group)
  scene.add(new THREE.AmbientLight(0xffffff, 1.25))

  const keyLight = new THREE.PointLight(0x3da5a5, 5.4, 14)
  keyLight.position.set(2.4, 2.2, 4)
  scene.add(keyLight)

  const rimLight = new THREE.PointLight(0xa3d5d3, 2.2, 10)
  rimLight.position.set(-2.2, -1.2, 3.4)
  scene.add(rimLight)

  // Champ d'étoiles en fond, léger effet de parallaxe
  const starCount = 260
  const starPositions = new Float32Array(starCount * 3)
  for (let i = 0; i < starCount; i += 1) {
    const radius = 4.6 + Math.random() * 4.2
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(Math.random() * 2 - 1)
    starPositions[i * 3] = radius * Math.sin(phi) * Math.cos(theta)
    starPositions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta)
    starPositions[i * 3 + 2] = radius * Math.cos(phi) - 3
  }
  const starGeometry = new THREE.BufferGeometry()
  starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
  const stars = new THREE.Points(
    starGeometry,
    new THREE.PointsMaterial({ color: 0xdfeeee, size: 0.028, sizeAttenuation: true, transparent: true, opacity: 0.75 }),
  )
  scene.add(stars)

  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 96, 96),
    new THREE.MeshStandardMaterial({ color: 0x0f4c5c, roughness: 0.26, metalness: 0.24, emissive: 0x0b2f39, emissiveIntensity: 0.62 }),
  )
  group.add(planet)

  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.76, 96, 96),
    new THREE.MeshBasicMaterial({
      color: 0x3da5a5,
      transparent: true,
      opacity: 0.32,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  group.add(atmosphere)

  const outerGlow = new THREE.Mesh(
    new THREE.SphereGeometry(2.05, 64, 64),
    new THREE.MeshBasicMaterial({
      color: 0x3da5a5,
      transparent: true,
      opacity: 0.1,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  group.add(outerGlow)

  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(1.96, 0.03, 32, 220),
    new THREE.MeshBasicMaterial({
      color: 0xeaf6f5,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  halo.rotation.x = Math.PI / 2.42
  halo.rotation.z = -0.25
  group.add(halo)

  const reticleGeometry = new THREE.BufferGeometry().setFromPoints(
    new THREE.EllipseCurve(0, 0, 2.18, 2.18).getPoints(180),
  )
  const reticle = new THREE.LineLoop(
    reticleGeometry,
    new THREE.LineDashedMaterial({ color: 0xa3d5d3, transparent: true, opacity: 0.5, dashSize: 0.06, gapSize: 0.05 }),
  )
  reticle.computeLineDistances()
  reticle.rotation.x = Math.PI / 2.2
  group.add(reticle)

  const ringConfigs = [
    { radius: 2.36, tiltX: Math.PI / 2.5, tiltZ: 0.32, speed: 0.5, size: 0.05, opacity: 0.55 },
    { radius: 2.72, tiltX: Math.PI / 2.15, tiltZ: -0.6, speed: -0.34, size: 0.036, opacity: 0.34 },
    { radius: 2.12, tiltX: Math.PI / 1.7, tiltZ: 1.05, speed: 0.7, size: 0.03, opacity: 0.3 },
  ]

  const satellites = ringConfigs.map(config => {
    const tilt = new THREE.Object3D()
    tilt.rotation.x = config.tiltX
    tilt.rotation.z = config.tiltZ
    group.add(tilt)

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(config.radius, 0.01, 20, 200),
      new THREE.MeshBasicMaterial({
        color: 0x3da5a5,
        transparent: true,
        opacity: config.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    tilt.add(ring)

    const satellite = new THREE.Mesh(
      new THREE.SphereGeometry(config.size, 20, 20),
      new THREE.MeshBasicMaterial({ color: 0xeaf6f5 }),
    )
    tilt.add(satellite)

    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(config.size * 2.6, 20, 20),
      new THREE.MeshBasicMaterial({
        color: 0xa3d5d3,
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    satellite.add(glow)

    return { satellite, radius: config.radius, speed: config.speed }
  })

  const resize = () => {
    const bounds = container.getBoundingClientRect()
    const width = Math.max(1, Math.round(container.clientWidth || bounds.width || 320))
    const height = Math.max(1, Math.round(container.clientHeight || bounds.height || 320))
    const viewHeight = 4.9
    const viewWidth = viewHeight * (width / height)

    renderer.setSize(width, height, false)
    camera.left = -viewWidth / 2
    camera.right = viewWidth / 2
    camera.top = viewHeight / 2
    camera.bottom = -viewHeight / 2
    camera.updateProjectionMatrix()
  }

  let resizeFrame
  const queueResize = () => {
    window.cancelAnimationFrame(resizeFrame)
    resizeFrame = window.requestAnimationFrame(resize)
  }

  const animate = () => {
    const elapsed = clock.getElapsedTime()
    const time = reduceMotion ? 0 : elapsed

    group.position.set(0, 0, 0)
    group.rotation.x = -0.04 + Math.sin(time * 0.22) * 0.025
    group.rotation.y = Math.sin(time * 0.24) * 0.05
    planet.rotation.y = time * 0.34
    atmosphere.rotation.y = time * 0.12
    halo.rotation.z = time * 0.22
    reticle.rotation.z = -time * 0.08
    stars.rotation.y = time * 0.01

    satellites.forEach(sat => {
      const angle = time * sat.speed
      sat.satellite.position.set(Math.cos(angle) * sat.radius, Math.sin(angle) * sat.radius, 0)
    })

    renderer.render(scene, camera)
    frameId = window.requestAnimationFrame(animate)
  }

  resize()
  window.requestAnimationFrame(resize)
  window.setTimeout(resize, 250)
  animate()

  const observer = new ResizeObserver(resize)
  observer.observe(container)
  window.addEventListener('scroll', queueResize, { passive: true })
  window.addEventListener('resize', queueResize)

  return () => {
    window.cancelAnimationFrame(frameId)
    window.cancelAnimationFrame(resizeFrame)
    observer.disconnect()
    window.removeEventListener('scroll', queueResize)
    window.removeEventListener('resize', queueResize)
    renderer.dispose()
    scene.traverse(object => {
      if (object.geometry) object.geometry.dispose()
      if (object.material) object.material.dispose()
    })
    if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement)
  }
}

createApp({
  data() {
    return {
      trades: [],
      stats: {},
      accounts: [],
      activeAccountId: readStoredAccount(),
      violations: [],
      calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
      calendarAuto: true,
      selectedDay: null,
    }
  },

  computed: {
    activeAccount() {
      return this.accounts.find(a => a.id === this.activeAccountId) || null
    },

    scopedTrades() {
      if (!this.activeAccountId) return this.trades
      return this.trades.filter(trade => trade.account_id === this.activeAccountId)
    },

    balanceDisplay() {
      if (this.activeAccount) return this.activeAccount.current_balance
      return this.accounts.reduce((sum, a) => sum + (Number(a.current_balance) || 0), 0)
    },

    pillarCompliance() {
      const isAnalyzed = pillars => pillars.prix != null || pillars.momentum != null || pillars.structure != null
      const analyzed = this.scopedTrades.filter(trade => isAnalyzed(trade.pillars || {}))
      const total = analyzed.length
      const pending = this.scopedTrades.length - total
      if (!total) return { total: 0, pending, prixPct: 0, momentumPct: 0, structurePct: 0, fullPct: 0 }
      const score = value => (value === true ? 1 : value === 'partial' ? 0.5 : 0)
      let prixSum = 0
      let momentumSum = 0
      let structureSum = 0
      let fullCount = 0
      analyzed.forEach(trade => {
        const pillars = trade.pillars || {}
        prixSum += score(pillars.prix)
        momentumSum += score(pillars.momentum)
        structureSum += score(pillars.structure)
        if (pillars.prix === true && pillars.momentum === true && pillars.structure === true) fullCount += 1
      })
      return {
        total,
        pending,
        prixPct: Math.round((prixSum / total) * 100),
        momentumPct: Math.round((momentumSum / total) * 100),
        structurePct: Math.round((structureSum / total) * 100),
        fullPct: Math.round((fullCount / total) * 100),
      }
    },

    closedTradesByDate() {
      return this.scopedTrades
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
      this.scopedTrades.forEach(trade => {
        if (trade.status === 'open') return
        const dateKey = (trade.closed_at || trade.timestamp || '').slice(0, 10)
        if (!dateKey) return
        if (!map[dateKey]) map[dateKey] = { pnl: 0, trades: 0, wins: 0, analyzed: 0, compliant: 0 }
        map[dateKey].pnl += Number(trade.pnl_amount) || 0
        map[dateKey].trades += 1
        if (trade.status === 'win') map[dateKey].wins += 1
        const pillars = trade.pillars || {}
        const isAnalyzed = pillars.prix != null || pillars.momentum != null || pillars.structure != null
        if (isAnalyzed) {
          map[dateKey].analyzed += 1
          if (pillars.prix === true && pillars.momentum === true && pillars.structure === true) {
            map[dateKey].compliant += 1
          }
        }
      })
      return map
    },

    violationsByDate() {
      const map = {}
      this.violations.forEach(v => {
        if (v.resolved) return
        if (this.activeAccountId && v.account_id !== this.activeAccountId) return
        const key = (v.date || '').slice(0, 10)
        if (!key) return
        map[key] = (map[key] || 0) + 1
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
        const compliancePct = info && info.analyzed ? Math.round((info.compliant / info.analyzed) * 100) : null
        const complianceTone = compliancePct === null ? '' : compliancePct >= 70 ? 'high' : compliancePct >= 40 ? 'mid' : 'low'
        cells.push({ day, dateKey, pnl: info ? info.pnl : 0, trades: info ? info.trades : 0, compliancePct, complianceTone, violations: this.violationsByDate[dateKey] || 0 })
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
      const analyzed = entries.reduce((sum, [, v]) => sum + v.analyzed, 0)
      const compliant = entries.reduce((sum, [, v]) => sum + v.compliant, 0)
      return {
        trades,
        winRate: trades ? Math.round((wins / trades) * 100) : 0,
        pnl,
        compliancePct: analyzed ? Math.round((compliant / analyzed) * 100) : 0,
      }
    },

    // Jours du mois qui ont des trades — utilise pour la vue liste (mobile).
    calendarDays() {
      const weekdayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'short' })
      return this.calendarWeeks
        .flatMap(week => week.cells)
        .filter(cell => cell && cell.trades)
        .map(cell => ({ ...cell, weekday: weekdayFmt.format(new Date(cell.dateKey + 'T00:00:00')) }))
    },

    selectedDayTrades() {
      if (!this.selectedDay) return []
      return this.scopedTrades
        .filter(t => (t.closed_at || t.timestamp || '').slice(0, 10) === this.selectedDay)
        .slice()
        .sort((a, b) => new Date(a.closed_at || a.timestamp || 0) - new Date(b.closed_at || b.timestamp || 0))
    },

    selectedDayPnl() {
      return this.selectedDayTrades.reduce((sum, t) => sum + (Number(t.pnl_amount) || 0), 0)
    },

    selectedDayViolations() {
      if (!this.selectedDay) return []
      return this.violations.filter(v =>
        !v.resolved &&
        (v.date || '').slice(0, 10) === this.selectedDay &&
        (!this.activeAccountId || v.account_id === this.activeAccountId))
    },

    selectedDayLabel() {
      if (!this.selectedDay) return ''
      return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
        .format(new Date(this.selectedDay + 'T00:00:00'))
    },
  },

  mounted() {
    this.load()
    this.connectStream()
    mountPlanet(this.$refs.planetMount)
    window.addEventListener('keydown', this.onKey)
  },

  methods: {
    async load() {
      const [trades, stats, accounts, violations] = await Promise.all([
        fetch(apiUrl('/api/trades')).then(r => r.json()),
        fetch(apiUrl('/api/stats' + this.accountQuery())).then(r => r.json()),
        fetch(apiUrl('/api/accounts')).then(r => r.json()),
        fetch(apiUrl('/api/violations')).then(r => r.json()),
      ])
      this.trades = trades
      this.stats = stats
      this.accounts = Array.isArray(accounts) ? accounts : []
      if (this.activeAccountId && !this.accounts.some(a => a.id === this.activeAccountId)) {
        this.activeAccountId = ''
      }
      this.violations = Array.isArray(violations) ? violations.filter(v => !v.resolved) : []
      this.focusLatestTradeMonth()
    },

    accountQuery() {
      return this.activeAccountId ? `?account=${encodeURIComponent(this.activeAccountId)}` : ''
    },

    setAccount(id) {
      this.activeAccountId = id
      try {
        window.localStorage.setItem('trackrecord.account', id)
      } catch {
        /* ignore */
      }
      this.calendarAuto = true
      this.refreshStats()
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
        this.violations = this.violations.filter(v => v.trade_id !== next.id)
        this.refreshStats()
      })
      stream.addEventListener('accounts_updated', event => {
        const next = JSON.parse(event.data)
        if (Array.isArray(next)) this.accounts = next
      })
      stream.addEventListener('violation_added', event => {
        const v = JSON.parse(event.data)
        this.violations = [v, ...this.violations.filter(x => x.id !== v.id)]
      })
      stream.addEventListener('violation_updated', event => {
        const v = JSON.parse(event.data)
        this.violations = this.violations
          .map(x => (x.id === v.id ? v : x))
          .filter(x => !x.resolved)
      })
    },

    async refreshStats() {
      this.stats = await fetch(apiUrl('/api/stats' + this.accountQuery())).then(r => r.json())
    },

    shiftMonth(delta) {
      this.calendarAuto = false
      this.calendarMonth = new Date(this.calendarMonth.getFullYear(), this.calendarMonth.getMonth() + delta, 1)
    },

    openDay(cell) {
      if (!cell || !cell.trades) return
      this.selectedDay = cell.dateKey
    },

    closeDay() {
      this.selectedDay = null
    },

    onKey(event) {
      if (event.key === 'Escape') this.closeDay()
    },

    pillarClass(pillars, key) {
      const value = (pillars || {})[key]
      return value === true ? 'ok' : value === 'partial' ? 'partial' : value == null ? 'na' : 'no'
    },

    tradeTone(trade) {
      return trade.status === 'win' ? 'win' : trade.status === 'loss' ? 'loss' : ''
    },

    focusLatestTradeMonth() {
      if (!this.calendarAuto || !this.scopedTrades.length) return
      const latest = this.scopedTrades.reduce((max, trade) => {
        const date = new Date(trade.closed_at || trade.timestamp || 0)
        return date > max ? date : max
      }, new Date(0))
      if (latest.getTime() > 0) {
        this.calendarMonth = new Date(latest.getFullYear(), latest.getMonth(), 1)
      }
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
      <div class="planet-bg" ref="planetMount"></div>
      <header class="topbar">
        <div class="brand">
          <div class="logo"><img src="/ceoverse-logo.png" alt="Ceoverse" /></div>
          <div>
            <h1>Trading Journal</h1>
            <p class="subtitle">{{ activeAccount ? activeAccount.label : 'Tous comptes' }} · ATM</p>
          </div>
        </div>
        <div class="account-switch" v-if="accounts.length">
          <button type="button" class="account-chip" :class="{ active: !activeAccountId }" @click="setAccount('')">Global</button>
          <button
            v-for="a in accounts"
            :key="a.id"
            type="button"
            class="account-chip"
            :class="{ active: activeAccountId === a.id }"
            @click="setAccount(a.id)"
          >{{ a.label }}</button>
        </div>
        <div class="top-actions">
          <span class="status-pill"><span class="live-dot"></span><span class="status-label">Live</span></span>
          <button class="btn ghost" @click="load">Refresh</button>
        </div>
      </header>

      <div class="layout">
        <section class="stats">
          <div class="metric tone-teal-deep">
            <span class="metric-icon">#</span>
            <div class="metric-body"><p class="label">Trades</p><div class="value">{{ stats.total || 0 }}</div></div>
          </div>
          <div class="metric tone-teal-mid">
            <span class="metric-icon">○</span>
            <div class="metric-body"><p class="label">Ouverts</p><div class="value">{{ stats.open || 0 }}</div></div>
          </div>
          <div class="metric tone-teal-light">
            <span class="metric-icon">%</span>
            <div class="metric-body"><p class="label">Win rate</p><div class="value good">{{ stats.win_rate ?? 0 }}%</div></div>
          </div>
          <div class="metric tone-teal-deep">
            <span class="metric-icon">R</span>
            <div class="metric-body"><p class="label">Avg RR</p><div class="value">{{ stats.avg_rr ?? 0 }}R</div></div>
          </div>
          <div class="metric tone-pnl" :class="{ good: (stats.avg_pnl_pct || 0) >= 0, bad: (stats.avg_pnl_pct || 0) < 0 }">
            <span class="metric-icon">±</span>
            <div class="metric-body"><p class="label">PnL moyen</p><div class="value" :class="{ good: (stats.avg_pnl_pct || 0) >= 0, bad: (stats.avg_pnl_pct || 0) < 0 }">{{ stats.avg_pnl_pct ?? 0 }}%</div></div>
          </div>
          <div class="metric tone-teal">
            <span class="metric-icon">$</span>
            <div class="metric-body"><p class="label">Balance PF</p><div class="value">{{ money(balanceDisplay) }}</div></div>
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
                  :class="cell ? [cell.trades ? (cell.pnl >= 0 ? 'win has-data' : 'loss has-data') : '', cell.violations ? 'plan-breach' : '', cell.trades ? 'clickable' : ''] : 'empty'"
                  @click="cell && cell.trades ? openDay(cell) : null"
                >
                  <template v-if="cell">
                    <div class="calendar-day-row">
                      <span class="calendar-day">{{ cell.day }}</span>
                      <span class="calendar-day-marks">
                        <span
                          v-if="cell.violations"
                          class="plan-flag"
                          :title="cell.violations + ' entorse(s) au plan'"
                        >⚠</span>
                        <span
                          v-if="cell.trades"
                          class="discipline-dot"
                          :class="'discipline-' + cell.complianceTone"
                          :title="cell.compliancePct + '% conforme au plan'"
                        ></span>
                      </span>
                    </div>
                    <span v-if="cell.trades" class="calendar-pnl">{{ money(cell.pnl) }}</span>
                    <span v-if="cell.trades" class="calendar-trades">{{ cell.trades }} trade{{ cell.trades > 1 ? 's' : '' }}</span>
                  </template>
                </div>
                <div class="calendar-total" :class="{ good: week.total > 0, bad: week.total < 0 }">{{ week.hasData ? money(week.total) : '—' }}</div>
              </template>
            </div>
          </div>

          <ul class="calendar-list">
            <li v-if="!calendarDays.length" class="calendar-list-empty">Aucun trade ce mois</li>
            <li
              v-for="d in calendarDays"
              :key="d.dateKey"
              class="calendar-list-row"
              :class="[d.pnl >= 0 ? 'win' : 'loss', d.violations ? 'plan-breach' : '']"
              @click="openDay(d)"
            >
              <div class="cl-date"><strong>{{ d.day }}</strong><span>{{ d.weekday }}</span></div>
              <div class="cl-meta">
                <span class="calendar-pnl">{{ money(d.pnl) }}</span>
                <span class="calendar-trades">{{ d.trades }} trade{{ d.trades > 1 ? 's' : '' }}</span>
              </div>
              <span class="cl-marks">
                <span v-if="d.violations" class="plan-flag">⚠</span>
                <span class="discipline-dot" :class="'discipline-' + d.complianceTone"></span>
              </span>
            </li>
          </ul>

          <div class="calendar-footer">
            <div class="calendar-stat tone-teal-mid"><span class="label">Trades ce mois</span><strong>{{ monthStats.trades }}</strong></div>
            <div class="calendar-stat tone-teal-deep"><span class="label">Win rate</span><strong>{{ monthStats.winRate }}%</strong></div>
            <div class="calendar-stat tone-pnl" :class="{ good: monthStats.pnl >= 0, bad: monthStats.pnl < 0 }"><span class="label">PnL du mois</span><strong :class="{ good: monthStats.pnl >= 0, bad: monthStats.pnl < 0 }">{{ money(monthStats.pnl) }}</strong></div>
            <div class="calendar-stat tone-teal-light"><span class="label">Conformité plan</span><strong>{{ monthStats.compliancePct }}%</strong></div>
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
            <div class="section-head">
              <h2>Conformité ATM</h2>
              <span class="equity-total" :class="{ good: pillarCompliance.fullPct >= 70, bad: pillarCompliance.fullPct < 40 }">{{ pillarCompliance.fullPct }}% conforme</span>
            </div>
            <div v-if="pillarCompliance.total" class="bars">
              <div class="bar-label">
                <span>Prix</span><div class="bar-track"><div class="bar-fill teal-deep" :style="{ width: pillarCompliance.prixPct + '%' }"></div></div><strong>{{ pillarCompliance.prixPct }}%</strong>
              </div>
              <div class="bar-label">
                <span>Momentum</span><div class="bar-track"><div class="bar-fill teal-mid" :style="{ width: pillarCompliance.momentumPct + '%' }"></div></div><strong>{{ pillarCompliance.momentumPct }}%</strong>
              </div>
              <div class="bar-label">
                <span>Structure</span><div class="bar-track"><div class="bar-fill teal-light" :style="{ width: pillarCompliance.structurePct + '%' }"></div></div><strong>{{ pillarCompliance.structurePct }}%</strong>
              </div>
              <p v-if="pillarCompliance.pending" class="label" style="margin-top: 2px;">{{ pillarCompliance.pending }} trade{{ pillarCompliance.pending > 1 ? 's' : '' }} en attente d'analyse</p>
            </div>
            <div v-else class="empty">Aucun trade analysé pour le moment</div>
          </article>
        </section>
      </div>

      <div v-if="selectedDay" class="day-modal" @click.self="closeDay">
        <div class="day-modal-card">
          <div class="day-modal-head">
            <div>
              <h3>{{ selectedDayLabel }}</h3>
              <p class="day-modal-sub">
                {{ selectedDayTrades.length }} trade{{ selectedDayTrades.length > 1 ? 's' : '' }} ·
                <span :class="{ good: selectedDayPnl >= 0, bad: selectedDayPnl < 0 }">{{ money(selectedDayPnl) }}</span>
              </p>
            </div>
            <button type="button" class="icon-btn" @click="closeDay">✕</button>
          </div>

          <div v-if="selectedDayViolations.length" class="day-breaches">
            <p v-for="(v, i) in selectedDayViolations" :key="i">⚠ {{ v.message }}</p>
          </div>

          <div class="day-trades">
            <article v-for="t in selectedDayTrades" :key="t.id" class="day-trade" :class="tradeTone(t)">
              <div class="day-trade-top">
                <span class="dt-symbol">{{ t.symbol }}</span>
                <span class="dt-dir" :class="t.direction === 'SHORT' ? 'short' : 'long'">{{ t.direction }}</span>
                <span v-if="t.timeframe" class="dt-tf">{{ t.timeframe }}</span>
                <span class="dt-pnl" :class="{ good: (t.pnl_amount || 0) >= 0, bad: (t.pnl_amount || 0) < 0 }">
                  {{ t.status === 'open' ? 'Ouvert' : money(t.pnl_amount) }}<template v-if="t.pnl_pct != null"> ({{ t.pnl_pct }}%)</template>
                </span>
              </div>
              <div class="day-trade-grid">
                <div v-if="t.entry != null"><span>Entrée</span>{{ t.entry }}</div>
                <div v-if="t.sl != null"><span>SL</span>{{ t.sl }}</div>
                <div v-if="t.tp1 != null"><span>TP1</span>{{ t.tp1 }}</div>
                <div v-if="t.tp2 != null"><span>TP2</span>{{ t.tp2 }}</div>
                <div v-if="t.rr != null"><span>RR</span>{{ t.rr }}</div>
                <div v-if="t.risk_pct != null"><span>Risque</span>{{ t.risk_pct }}%</div>
                <div v-if="t.note != null"><span>Note</span>{{ t.note }}/10</div>
                <div v-if="t.session"><span>Session</span>{{ t.session }}</div>
              </div>
              <div class="day-trade-pillars">
                <span class="pill" :class="pillarClass(t.pillars, 'prix')">Prix</span>
                <span class="pill" :class="pillarClass(t.pillars, 'momentum')">Momentum</span>
                <span class="pill" :class="pillarClass(t.pillars, 'structure')">Structure</span>
              </div>
              <p v-if="t.comment" class="day-trade-comment">{{ t.comment }}</p>
              <a v-if="t.image_url" :href="assetUrl(t.image_url)" target="_blank" rel="noopener" class="day-trade-img">
                <img :src="assetUrl(t.image_url)" alt="capture du trade" loading="lazy" />
              </a>
            </article>
          </div>
        </div>
      </div>
    </main>
  `,
}).mount('#app')
