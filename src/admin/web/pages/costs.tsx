import { useEffect, useMemo, useRef, useState } from "react"
import type { UsageReport } from "../api"
import { money, SOURCE_LABELS, spend, ticks, tokens, type Bucket, type Range, type Series, type SessionSpend, type Split, type Spend, type Step } from "../spend"
import { Empty, ErrorBanner, PageHeader, relTime, Segmented, Skeleton, useApi } from "../ui"

const RANGES: { value: Range; label: string }[] = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "all", label: "All time" },
]

const SPLITS: { value: Split; label: string }[] = [
  { value: "model", label: "By model" },
  { value: "source", label: "By source" },
  { value: "person", label: "By person" },
]

type View = "bars" | "cumulative" | "table"

const PERIOD: Record<Range, string> = { "24h": "previous 24 hours", "7d": "previous 7 days", "30d": "previous 30 days", "90d": "previous 90 days", all: "" }

export function CostsPage({ openThread }: { openThread: (id: string) => void }) {
  const { data, error, reload } = useApi<UsageReport>("/api/usage", 60_000)
  const [range, setRange] = useState<Range>(() => (localStorage.getItem("costs.range") as Range) || "30d")
  const [split, setSplit] = useState<Split>(() => (localStorage.getItem("costs.split") as Split) || "model")
  const [view, setView] = useState<View>("bars")
  useEffect(() => localStorage.setItem("costs.range", range), [range])
  useEffect(() => localStorage.setItem("costs.split", split), [split])

  const result = useMemo(() => (data ? spend(data, range, split) : undefined), [data, range, split])

  return (
    <>
      <PageHeader
        title="Costs"
        subtitle="What every session has cost, from the price OpenCode records on each model call. Subagents count towards the conversation that started them."
        actions={data && <span className="muted small">updated {relTime(data.generatedAt)}</span>}
      />
      <ErrorBanner error={error} onRetry={reload} />
      {!data || !result ? (
        <Skeleton rows={5} />
      ) : data.rows.length === 0 ? (
        <section className="card">
          <Empty icon="$" title="Nothing spent yet">
            Costs show up here once the bot has answered a message with a paid model.
          </Empty>
        </section>
      ) : (
        <>
          <div className="toolbar">
            <Segmented value={range} options={RANGES} onChange={setRange} />
            <Segmented value={split} options={SPLITS} onChange={setSplit} />
          </div>
          <Stats spend={result} range={range} />
          <section className="card spend-card">
            <div className="card-head">
              <h3>{view === "cumulative" ? "Running total" : `Spend per ${result.step}`}</h3>
              <Segmented
                value={view}
                options={[
                  { value: "bars", label: "Bars" },
                  { value: "cumulative", label: "Running total" },
                  { value: "table", label: "Table" },
                ]}
                onChange={setView}
              />
            </div>
            {view === "bars" && <Legend series={result.series} spend={result} />}
            {view === "bars" && <BarChart spend={result} />}
            {view === "cumulative" && <LineChart spend={result} />}
            {view === "table" && <BucketTable spend={result} />}
          </section>
          <div className="grid-3">
            <Breakdown title="Models" rows={result.breakdown.model} total={result.cost} />
            <Breakdown title="Sources" rows={result.breakdown.source} total={result.cost} />
            <Breakdown title="People" rows={result.breakdown.person} total={result.cost} />
          </div>
          <TopSessions sessions={result.sessions} people={data.people} openThread={openThread} />
        </>
      )}
    </>
  )
}

function Stats({ spend: s, range }: { spend: Spend; range: Range }) {
  const days = Math.max(1, (s.to - s.from) / 86_400_000)
  const delta = s.previous === null ? null : s.previous === 0 ? null : (s.cost - s.previous) / s.previous
  const cached = s.tokens.cacheRead
  const used = s.tokens.input + s.tokens.output + s.tokens.reasoning
  return (
    <div className="stats">
      <div className="stat static">
        <span className="stat-label">Spent</span>
        <span className="stat-value">{money(s.cost)}</span>
        <span className="stat-detail">
          {s.previous === null
            ? "since the first session"
            : delta === null
              ? `nothing in the ${PERIOD[range]}`
              : `${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta * 100).toFixed(0)}% vs ${PERIOD[range]} (${money(s.previous)})`}
        </span>
      </div>
      <div className="stat static">
        <span className="stat-label">{range === "24h" ? "Per hour" : "Per day"}</span>
        <span className="stat-value">{money(range === "24h" ? s.cost / 24 : s.cost / days)}</span>
        <span className="stat-detail">on average</span>
      </div>
      <div className="stat static">
        <span className="stat-label">Model calls</span>
        <span className="stat-value">{s.turns.toLocaleString("en-US")}</span>
        <span className="stat-detail">{s.turns ? `${money(s.cost / s.turns)} each on average` : "none in this range"}</span>
      </div>
      <div className="stat static">
        <span className="stat-label">Tokens</span>
        <span className="stat-value">{tokens(used)}</span>
        <span className="stat-detail">{cached ? `plus ${tokens(cached)} read from cache` : "in and out"}</span>
      </div>
    </div>
  )
}

function Legend({ series, spend: s }: { series: Series[]; spend: Spend }) {
  if (series.length < 2) return null
  const totals = series.map((_, i) => s.buckets.reduce((sum, b) => sum + b.values[i]!, 0))
  return (
    <ul className="spend-legend">
      {series.map((x, i) => (
        <li key={x.key} className={totals[i] ? "" : "faded"}>
          <span className="swatch" style={{ background: x.color }} />
          <span className="spend-legend-label">{x.label}</span>
          <span className="mono muted">{money(totals[i]!)}</span>
        </li>
      ))}
    </ul>
  )
}

const H = 280
const M = { top: 12, right: 8, bottom: 28, left: 56 }

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, e!.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, width }
}

function label(t: number, step: Step, long = false): string {
  const d = new Date(t)
  if (step === "hour") return long ? d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(long ? { weekday: "short", year: "numeric" } : {}) })
  return step === "week" && long ? `Week of ${date}` : date
}

function axisMoney(v: number, max: number): string {
  if (v === 0) return "$0"
  if (max < 0.1) return `$${v.toFixed(3)}`
  if (max < 1) return `$${v.toFixed(2)}`
  if (max < 10) return `$${v.toFixed(v % 1 ? 1 : 0)}`
  return `$${Math.round(v).toLocaleString("en-US")}`
}

/** Plot frame: gridlines, y labels and x labels shared by both chart forms. */
function Frame({ width, max, buckets, step, children }: { width: number; max: number; buckets: Bucket[]; step: Step; children: React.ReactNode }) {
  const ys = ticks(max)
  const top = ys[ys.length - 1] || 1
  const plotH = H - M.top - M.bottom
  const slot = (width - M.left - M.right) / buckets.length
  const every = Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor((width - M.left) / 90))))
  return (
    <>
      {ys.map((v) => {
        const y = M.top + plotH - (v / top) * plotH
        return (
          <g key={v}>
            <line x1={M.left} x2={width - M.right} y1={y} y2={y} className={v === 0 ? "axis-base" : "axis-grid"} />
            <text x={M.left - 10} y={y} className="axis-label" textAnchor="end" dominantBaseline="middle">
              {axisMoney(v, top)}
            </text>
          </g>
        )
      })}
      {buckets.map((b, i) =>
        (buckets.length - 1 - i) % every === 0 ? (
          <text key={b.start} x={M.left + slot * (i + 0.5)} y={H - 8} className="axis-label" textAnchor="middle">
            {label(b.start, step)}
          </text>
        ) : null,
      )}
      {children}
    </>
  )
}

function useHover(count: number) {
  const [hover, setHover] = useState<number>()
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") setHover((h) => Math.min(count - 1, (h ?? -1) + 1))
    else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? count) - 1))
    else if (e.key === "Escape") setHover(undefined)
    else return
    e.preventDefault()
  }
  return { hover, setHover, onKeyDown }
}

/** Rounded at the data end only; the base stays square on the axis. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.min(r, w / 2, h)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

function BarChart({ spend: s }: { spend: Spend }) {
  const { ref, width } = useWidth()
  const { hover, setHover, onKeyDown } = useHover(s.buckets.length)
  const max = Math.max(...s.buckets.map((b) => b.total), 0)
  const top = ticks(max).at(-1) || 1
  const plotH = H - M.top - M.bottom
  const slot = (width - M.left - M.right) / s.buckets.length
  const barW = Math.max(2, Math.min(40, slot * 0.72))
  const base = M.top + plotH

  return (
    <div className="chart" ref={ref}>
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={`Spend per ${s.step}, ${money(s.cost)} in total. Use the arrow keys to read each ${s.step}.`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setHover(undefined)}
        onPointerLeave={() => setHover(undefined)}
      >
        <Frame width={width} max={max} buckets={s.buckets} step={s.step}>
          {s.buckets.map((b, i) => {
            const x = M.left + slot * i + (slot - barW) / 2
            const filled = b.values.map((v, j) => ({ v, j })).filter((p) => (p.v / top) * plotH >= 0.5)
            let y = base
            return (
              <g key={b.start} className={`bar-group ${hover === undefined ? "" : hover === i ? "on" : "off"}`}>
                {filled.map(({ v, j }, k) => {
                  const h = (v / top) * plotH
                  y -= h
                  const last = k === filled.length - 1
                  // A 2px surface gap separates stacked segments.
                  const drawn = last ? h : Math.max(0.5, h - 2)
                  const yy = last ? y : y + (h - drawn)
                  return last ? (
                    <path key={j} d={topRounded(x, yy, barW, drawn, 4)} fill={s.series[j]!.color} />
                  ) : (
                    <rect key={j} x={x} y={yy} width={barW} height={drawn} fill={s.series[j]!.color} />
                  )
                })}
                <rect x={M.left + slot * i} y={M.top} width={slot} height={plotH} fill="transparent" onPointerEnter={() => setHover(i)} />
              </g>
            )
          })}
        </Frame>
      </svg>
      {hover !== undefined && <Tooltip spend={s} index={hover} x={M.left + slot * (hover + 0.5)} width={width} />}
    </div>
  )
}

function LineChart({ spend: s }: { spend: Spend }) {
  const { ref, width } = useWidth()
  const { hover, setHover, onKeyDown } = useHover(s.buckets.length)
  const running = s.buckets.reduce<number[]>((acc, b) => [...acc, (acc.at(-1) ?? 0) + b.total], [])
  const max = running.at(-1) ?? 0
  const top = ticks(max).at(-1) || 1
  const plotH = H - M.top - M.bottom
  const slot = (width - M.left - M.right) / s.buckets.length
  const px = (i: number) => M.left + slot * (i + 0.5)
  const py = (v: number) => M.top + plotH - (v / top) * plotH
  const line = running.map((v, i) => `${i ? "L" : "M"}${px(i)},${py(v)}`).join("")
  const area = `${line}L${px(running.length - 1)},${py(0)}L${px(0)},${py(0)}Z`

  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const i = Math.floor((e.clientX - box.left - M.left) / slot)
    setHover(Math.max(0, Math.min(s.buckets.length - 1, i)))
  }

  return (
    <div className="chart" ref={ref}>
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={`Running total of spend, reaching ${money(max)}. Use the arrow keys to read each ${s.step}.`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setHover(undefined)}
        onPointerMove={pick}
        onPointerLeave={() => setHover(undefined)}
      >
        <defs>
          <linearGradient id="spend-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <Frame width={width} max={max} buckets={s.buckets} step={s.step}>
          <path d={area} fill="url(#spend-area)" />
          <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {hover !== undefined && (
            <>
              <line x1={px(hover)} x2={px(hover)} y1={M.top} y2={M.top + plotH} className="crosshair" />
              <circle cx={px(hover)} cy={py(running[hover]!)} r={5} fill="var(--accent)" stroke="var(--panel-solid)" strokeWidth={2} />
            </>
          )}
        </Frame>
      </svg>
      {hover !== undefined && <Tooltip spend={s} index={hover} x={px(hover)} width={width} running={running[hover]} />}
    </div>
  )
}

function Tooltip({ spend: s, index, x, width, running }: { spend: Spend; index: number; x: number; width: number; running?: number }) {
  const b = s.buckets[index]!
  const rows = s.series.map((series, i) => ({ series, v: b.values[i]! })).filter((r) => r.v > 0)
  const left = x > width * 0.6
  return (
    <div className="chart-tip" style={left ? { right: width - x + 14 } : { left: x + 14 }}>
      <div className="chart-tip-head">{label(b.start, s.step, true)}</div>
      {running !== undefined && (
        <div className="chart-tip-row strong">
          <span className="mono">{money(running)}</span>
          <span className="muted">running total</span>
        </div>
      )}
      <div className="chart-tip-row strong">
        <span className="mono">{money(b.total)}</span>
        <span className="muted">spent this {s.step}</span>
      </div>
      {s.series.length > 1 &&
        rows.map((r) => (
          <div key={r.series.key} className="chart-tip-row">
            <span className="key" style={{ background: r.series.color }} />
            <span className="mono">{money(r.v)}</span>
            <span className="muted">{r.series.label}</span>
          </div>
        ))}
    </div>
  )
}

function BucketTable({ spend: s }: { spend: Spend }) {
  const rows = s.buckets.filter((b) => b.total > 0).reverse()
  if (!rows.length) return <p className="muted">Nothing spent in this range.</p>
  return (
    <div className="spend-table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{s.step === "hour" ? "Hour" : s.step === "day" ? "Day" : "Week"}</th>
            {s.series.length > 1 &&
              s.series.map((x) => (
                <th key={x.key} className="num">
                  {x.label}
                </th>
              ))}
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.start}>
              <td>{label(b.start, s.step, true)}</td>
              {s.series.length > 1 &&
                b.values.map((v, i) => (
                  <td key={i} className="num mono muted">
                    {v ? money(v) : "–"}
                  </td>
                ))}
              <td className="num mono">{money(b.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Breakdown({ title, rows, total }: { title: string; rows: Spend["breakdown"]["model"]; total: number }) {
  const max = Math.max(...rows.map((r) => r.cost), 0)
  return (
    <section className="card">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="muted">Nothing spent in this range.</p>
      ) : (
        <ul className="bars spend-bars">
          {rows.slice(0, 8).map((r) => (
            <li key={r.key} title={`${r.label}: ${money(r.cost)} (${total ? Math.round((r.cost / total) * 100) : 0}%)`}>
              <span className="bar-label">{r.label}</span>
              <span className="bar">
                <span style={{ width: `${Math.max(2, (r.cost / (max || 1)) * 100)}%`, background: r.color }} />
              </span>
              <span className="bar-value mono">{money(r.cost)}</span>
            </li>
          ))}
          {rows.length > 8 && <li className="muted small">and {rows.length - 8} more</li>}
        </ul>
      )}
    </section>
  )
}

function TopSessions({ sessions, people, openThread }: { sessions: SessionSpend[]; people: UsageReport["people"]; openThread: (id: string) => void }) {
  const [all, setAll] = useState(false)
  if (!sessions.length) return null
  const shown = all ? sessions : sessions.slice(0, 10)
  const who = (s: SessionSpend["session"]) => {
    if (s.source === "schedule") return `⏰ ${s.schedule}`
    if (s.source === "conversation") return s.userId === null ? "Conversation" : (people.find((p) => p.id === s.userId)?.name ?? String(s.userId))
    return SOURCE_LABELS[s.source]
  }
  return (
    <section className="card flush">
      <div className="card-head spend-sessions-head">
        <h3>Most expensive sessions</h3>
        <span className="muted small">{sessions.length} sessions spent money in this range</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Session</th>
            <th>From</th>
            <th>Main model</th>
            <th className="num">Calls</th>
            <th className="num">Tokens</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.session.id} className={r.session.open ? "clickable" : ""} onClick={() => r.session.open && openThread(r.session.open)}>
              <td className="thread-title">
                {r.session.title ?? <span className="muted">Untitled</span>}
                {r.session.parentID && <span className="muted small"> · subagent</span>}
              </td>
              <td className="muted">{who(r.session)}</td>
              <td className="mono small muted">{r.model.slice(r.model.indexOf("/") + 1)}</td>
              <td className="num">{r.turns}</td>
              <td className="num mono">{tokens(r.tokens)}</td>
              <td className="num mono">{money(r.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sessions.length > 10 && (
        <div className="spend-more">
          <button className="link" onClick={() => setAll(!all)}>
            {all ? "Show the top 10" : `Show all ${sessions.length}`}
          </button>
        </div>
      )}
    </section>
  )
}
