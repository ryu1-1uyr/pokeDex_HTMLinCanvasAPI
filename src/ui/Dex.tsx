import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  fetchDetail,
  fetchGeneration,
  fillJaNames,
  getJaName,
  toCss,
  TYPE_COLORS,
  TYPE_JA,
  type DexEntry,
  type PokemonDetail,
} from '../api/pokeapi'
import { playCry as playCryAudio } from '../fx/cry'
import { fx } from '../fx/fxStore'
import { useRegion } from '../fx/useRegion'

const GENERATIONS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX']
const STAT_LABELS = ['HP', 'こうげき', 'ぼうぎょ', 'とくこう', 'とくぼう', 'すばやさ']
const STAT_SCALE = 180

const pad = (n: number) => String(n).padStart(4, '0')

function ShellButton(props: {
  color?: number
  className?: string
  onClick: () => void
  children: ReactNode
  title?: string
}) {
  const ref = useRegion<HTMLButtonElement>('button', 10, props.color ?? 0)
  return (
    <button
      ref={ref}
      className={`shell-btn c${props.color ?? 0} ${props.className ?? ''}`}
      onClick={props.onClick}
      title={props.title}
    >
      {props.children}
    </button>
  )
}

function Led({ color }: { color: number }) {
  return <span ref={useRegion<HTMLSpanElement>('led', 99, color)} className="led" />
}

export function Dex({ mode }: { mode: string }) {
  const [gen, setGen] = useState(1)
  const [entries, setEntries] = useState<DexEntry[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<PokemonDetail | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [nameTick, setNameTick] = useState(0)

  const deviceRef = useRegion<HTMLDivElement>('device', 28)
  const lensRef = useRegion<HTMLDivElement>('lens', 99)
  const mainScreenRef = useRegion<HTMLDivElement>('screen', 14)
  const statScreenRef = useRegion<HTMLDivElement>('screen', 14)
  const listScreenRef = useRegion<HTMLDivElement>('screen', 14)
  const holoRegion = useRegion<HTMLDivElement>('holo', 12)
  const holoEl = useRef<HTMLDivElement | null>(null)
  const holoRef = useCallback(
    (el: HTMLDivElement | null) => {
      holoEl.current = el
      holoRegion(el)
    },
    [holoRegion],
  )
  // The <img> is hidden while the particle morph is running.
  const [art, setArt] = useState<{ src: string; visible: boolean } | null>(null)
  const radarRef = useRegion<HTMLDivElement>('radar', 0)
  const listEl = useRef<HTMLUListElement | null>(null)

  // Generation list + lazy Japanese names
  useEffect(() => {
    const ctrl = new AbortController()
    fetchGeneration(gen)
      .then((list) => {
        if (ctrl.signal.aborted) return
        setError(null)
        setEntries(list)
        setSelectedId((cur) => (cur && list.some((e) => e.id === cur) ? cur : list[0]?.id ?? null))
        let pending = 0
        fillJaNames(
          list.map((e) => e.id),
          () => {
            if (pending) return
            pending = requestAnimationFrame(() => {
              pending = 0
              setNameTick((t) => t + 1)
            })
          },
          ctrl.signal,
        )
      })
      .catch((e) => setError(String(e)))
    return () => ctrl.abort()
  }, [gen])

  // Detail + shader parameters
  useEffect(() => {
    if (selectedId == null) return
    let cancelled = false
    fetchDetail(selectedId)
      .then((d) => {
        if (cancelled) return
        setDetail(d)
        const c1 = TYPE_COLORS[d.types[0]] ?? [0.9, 0.2, 0.2]
        const c2 = TYPE_COLORS[d.types[1]] ?? (c1.map((c) => Math.min(1, c * 0.6 + 0.4)) as typeof c1)
        fx.accent = c1
        fx.accent2 = c2
        fx.stats = d.stats.map((s) => Math.min(1, s / STAT_SCALE))
        const morph = fx.morph(d.artwork, () => holoEl.current)
        morph.started.then(() => !cancelled && setArt({ src: d.artwork, visible: false }))
        morph.done.then(() => !cancelled && setArt({ src: d.artwork, visible: true }))
      })
      .catch((e) => !cancelled && setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [selectedId])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) => e.name.includes(q) || (getJaName(e.id) ?? '').includes(query.trim()) || String(e.id) === q,
    )
    // nameTick: getJaName reads a cache that fills in asynchronously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, query, nameTick])

  const move = (delta: number) => {
    if (!filtered.length) return
    const i = filtered.findIndex((e) => e.id === selectedId)
    const next = filtered[(i + delta + filtered.length) % filtered.length]
    setSelectedId(next.id)
  }

  const randomPick = () => {
    if (entries.length) setSelectedId(entries[Math.floor(Math.random() * entries.length)].id)
  }

  const playCry = () => {
    if (detail?.cry) playCryAudio(detail.cry)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'ArrowDown') move(1)
      else if (e.key === 'ArrowUp') move(-1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    listEl.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const accentCss = detail ? toCss(TYPE_COLORS[detail.types[0]] ?? [0.9, 0.2, 0.2]) : undefined
  const total = detail?.stats.reduce((a, b) => a + b, 0) ?? 0

  return (
    <div ref={deviceRef} className="dex-inner" style={accentCss ? ({ '--accent': accentCss } as CSSProperties) : undefined}>
      <header className="dex-top">
        <div ref={lensRef} className="lens" />
        <div className="leds">
          <Led color={5} />
          <Led color={2} />
          <Led color={4} />
        </div>
        <h1 className="brand">
          POKéDEX <small>GPU</small>
        </h1>
        <span className="mode-chip">{mode}</span>
      </header>

      <main className="dex-body">
        <section className="col-left">
          <div ref={mainScreenRef} className="screen main-screen">
            {detail ? (
              <>
                <div ref={holoRef} className="holo-card">
                  <span className="dex-no">No.{pad(detail.id)}</span>
                  {art && (
                    <img
                      src={art.src}
                      alt={detail.jaName}
                      crossOrigin="anonymous"
                      className={art.visible ? 'art-shown' : 'art-hidden'}
                    />
                  )}
                </div>
                <div className="profile">
                  <h2>
                    {detail.jaName}
                    <span className="en">{detail.name}</span>
                  </h2>
                  <p className="genus">{detail.genus}</p>
                  <div className="types">
                    {detail.types.map((t) => (
                      <span key={t} className="type" style={{ '--type': toCss(TYPE_COLORS[t]) } as CSSProperties}>
                        {TYPE_JA[t] ?? t}
                      </span>
                    ))}
                  </div>
                  <dl className="metrics">
                    <dt>たかさ</dt>
                    <dd>{detail.height.toFixed(1)} m</dd>
                    <dt>おもさ</dt>
                    <dd>{detail.weight.toFixed(1)} kg</dd>
                  </dl>
                  <p className="flavor">{detail.flavor}</p>
                </div>
              </>
            ) : (
              <p className="loading">{error ?? 'LOADING…'}</p>
            )}
          </div>

          <div className="controls">
            <ShellButton onClick={() => move(-1)} title="前へ (↑)">
              ◀
            </ShellButton>
            <ShellButton onClick={() => move(1)} title="次へ (↓)">
              ▶
            </ShellButton>
            <ShellButton color={1} className="wide" onClick={playCry}>
              なきごえ
            </ShellButton>
            <ShellButton color={2} className="wide" onClick={randomPick}>
              ランダム
            </ShellButton>
          </div>
        </section>

        <section className="col-right">
          <div ref={statScreenRef} className="screen stat-screen">
            <div className="stat-head">
              <span>BASE STATS</span>
              <span>合計 {total}</span>
            </div>
            <div ref={radarRef} className="radar">
              {STAT_LABELS.map((label, i) => {
                const a = -Math.PI / 2 + (i * Math.PI) / 3
                return (
                  <span
                    key={label}
                    className="radar-label"
                    style={{ left: `${50 + Math.cos(a) * 45}%`, top: `${50 + Math.sin(a) * 45}%` }}
                  >
                    {label}
                    <b>{detail?.stats[i] ?? '-'}</b>
                  </span>
                )
              })}
            </div>
          </div>

          <div className="gens">
            {GENERATIONS.map((g, i) => (
              <ShellButton key={g} color={gen === i + 1 ? 3 : 0} className="gen" onClick={() => setGen(i + 1)}>
                {g}
              </ShellButton>
            ))}
          </div>

          <div ref={listScreenRef} className="screen list-screen">
            <input
              className="search"
              placeholder="なまえ / No. でけんさく"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <ul ref={listEl} className="list" role="listbox">
              {filtered.map((e) => (
                <li
                  key={e.id}
                  role="option"
                  aria-selected={e.id === selectedId}
                  onClick={() => setSelectedId(e.id)}
                >
                  <span className="no">{pad(e.id)}</span>
                  <span className="nm">{getJaName(e.id) ?? e.name}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
    </div>
  )
}
