import { createApp } from '/vendor/vue/vue.esm-browser.prod.js'
import * as THREE from '/vendor/three/three.module.js'

const DEFAULT_API_URL = 'https://vibrant-quietude-production-374a.up.railway.app'
const API = window.TRACK_RECORD_API_URL
  ?? (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? '' : DEFAULT_API_URL)

function apiUrl(path) {
  return `${API}${path}`
}

function assetUrl(path) {
  if (!path || path.startsWith('http') || path.startsWith('data:')) return path
  return `${API}${path}`
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
      propFirm: {},
      calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
      calendarAuto: true,
    }
  },

  computed: {
    pillarCompliance() {
      const total = this.trades.length
      if (!total) return { total: 0, prixPct: 0, momentumPct: 0, structurePct: 0, fullPct: 0 }
      const score = value => (value === true ? 1 : value === 'partial' ? 0.5 : 0)
      let prixSum = 0
      let momentumSum = 0
      let structureSum = 0
      let fullCount = 0
      this.trades.forEach(trade => {
        const pillars = trade.pillars || {}
        prixSum += score(pillars.prix)
        momentumSum += score(pillars.momentum)
        structureSum += score(pillars.structure)
        if (pillars.prix === true && pillars.momentum === true && pillars.structure === true) fullCount += 1
      })
      return {
        total,
        prixPct: Math.round((prixSum / total) * 100),
        momentumPct: Math.round((momentumSum / total) * 100),
        structurePct: Math.round((structureSum / total) * 100),
        fullPct: Math.round((fullCount / total) * 100),
      }
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
        if (!map[dateKey]) map[dateKey] = { pnl: 0, trades: 0, wins: 0, compliant: 0 }
        map[dateKey].pnl += Number(trade.pnl_amount) || 0
        map[dateKey].trades += 1
        if (trade.status === 'win') map[dateKey].wins += 1
        const pillars = trade.pillars || {}
        if (pillars.prix === true && pillars.momentum === true && pillars.structure === true) {
          map[dateKey].compliant += 1
        }
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
        const compliancePct = info && info.trades ? Math.round((info.compliant / info.trades) * 100) : null
        const complianceTone = compliancePct === null ? '' : compliancePct >= 70 ? 'high' : compliancePct >= 40 ? 'mid' : 'low'
        cells.push({ day, pnl: info ? info.pnl : 0, trades: info ? info.trades : 0, compliancePct, complianceTone })
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
      const compliant = entries.reduce((sum, [, v]) => sum + v.compliant, 0)
      return {
        trades,
        winRate: trades ? Math.round((wins / trades) * 100) : 0,
        pnl,
        compliancePct: trades ? Math.round((compliant / trades) * 100) : 0,
      }
    },
  },

  mounted() {
    this.load()
    this.connectStream()
    mountPlanet(this.$refs.planetMount)
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
            <p class="subtitle">ATM · Track record · 5ers 200K</p>
          </div>
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
            <div class="metric-body"><p class="label">Balance PF</p><div class="value">{{ money(propFirm.current_balance) }}</div></div>
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
                    <div class="calendar-day-row">
                      <span class="calendar-day">{{ cell.day }}</span>
                      <span
                        v-if="cell.trades"
                        class="discipline-dot"
                        :class="'discipline-' + cell.complianceTone"
                        :title="cell.compliancePct + '% conforme au plan'"
                      ></span>
                    </div>
                    <span v-if="cell.trades" class="calendar-pnl">{{ money(cell.pnl) }}</span>
                    <span v-if="cell.trades" class="calendar-trades">{{ cell.trades }} trade{{ cell.trades > 1 ? 's' : '' }}</span>
                  </template>
                </div>
                <div class="calendar-total" :class="{ good: week.total > 0, bad: week.total < 0 }">{{ week.hasData ? money(week.total) : '—' }}</div>
              </template>
            </div>
          </div>
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
                <span>Prix</span><div class="bar-track"><div class="bar-fill blue" :style="{ width: pillarCompliance.prixPct + '%' }"></div></div><strong>{{ pillarCompliance.prixPct }}%</strong>
              </div>
              <div class="bar-label">
                <span>Momentum</span><div class="bar-track"><div class="bar-fill violet" :style="{ width: pillarCompliance.momentumPct + '%' }"></div></div><strong>{{ pillarCompliance.momentumPct }}%</strong>
              </div>
              <div class="bar-label">
                <span>Structure</span><div class="bar-track"><div class="bar-fill green" :style="{ width: pillarCompliance.structurePct + '%' }"></div></div><strong>{{ pillarCompliance.structurePct }}%</strong>
              </div>
            </div>
            <div v-else class="empty">Aucun trade pour le moment</div>
          </article>
        </section>
      </div>
    </main>
  `,
}).mount('#app')
