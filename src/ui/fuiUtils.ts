import { useEffect, useState } from 'react'

/** Seconds the lock-on reticle takes to settle; the callouts and profile wait for it. */
export const LOCK_TIME = 0.55

export const pad = (n: number, w: number) => String(Math.floor(n)).padStart(w, '0')

/** Re-renders only the caller at `hz`, returning seconds since mount. */
export function useTicker(hz = 10) {
  const [t, setT] = useState(0)
  useEffect(() => {
    const start = performance.now()
    const id = setInterval(() => setT((performance.now() - start) / 1000), 1000 / hz)
    return () => clearInterval(id)
  }, [hz])
  return t
}

export function clock(t: number) {
  return `T+${pad(t / 3600, 2)}:${pad((t / 60) % 60, 2)}:${pad(t % 60, 2)}`
}

/** Deterministic jitter so values wobble like a live measurement. */
export function wobble(t: number, seed: number, amount: number) {
  return (Math.sin(t * 2.3 + seed) * 0.6 + Math.sin(t * 5.7 + seed * 1.7) * 0.4) * amount
}

