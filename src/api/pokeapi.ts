const BASE = 'https://pokeapi.co/api/v2'
const JA_NAME_CACHE_KEY = 'dex:ja-names:v1'
/** Persistent response cache. Bump the version to invalidate. */
const RESPONSE_CACHE = 'pokeapi-v1'

export interface DexEntry {
  id: number
  name: string
}

export interface PokemonDetail {
  id: number
  name: string
  jaName: string
  genus: string
  flavor: string
  types: string[]
  /** hp, attack, defense, special-attack, special-defense, speed */
  stats: number[]
  height: number
  weight: number
  artwork: string
  cry: string | null
}

interface NamedResource {
  name: string
  url: string
}

interface LocalizedName {
  name: string
  language: NamedResource
}

const idFromUrl = (url: string) => Number(url.split('/').filter(Boolean).pop())

const responseCache = new Map<string, Promise<unknown>>()

/**
 * PokeAPI's fair use policy asks clients to cache every resource locally.
 * Responses are static, so they are kept in Cache Storage across reloads and each
 * resource is requested at most once per browser. Falls back to a plain fetch
 * where Cache Storage is unavailable (insecure context, private mode).
 */
async function fetchCached(url: string): Promise<Response> {
  let cache: Cache | null = null
  try {
    cache = await caches.open(RESPONSE_CACHE)
    const hit = await cache.match(url)
    if (hit) return hit
  } catch {
    cache = null
  }
  const res = await fetch(url)
  if (res.ok && cache) cache.put(url, res.clone()).catch(() => {})
  return res
}

function getJson<T>(path: string): Promise<T> {
  let p = responseCache.get(path)
  if (!p) {
    p = fetchCached(BASE + path).then((r) => {
      if (!r.ok) throw new Error(`PokeAPI ${r.status}: ${path}`)
      return r.json()
    })
    p.catch(() => responseCache.delete(path))
    responseCache.set(path, p)
  }
  return p as Promise<T>
}

export async function fetchGeneration(gen: number): Promise<DexEntry[]> {
  const data = await getJson<{ pokemon_species: NamedResource[] }>(`/generation/${gen}`)
  return data.pokemon_species
    .map((s) => ({ id: idFromUrl(s.url), name: s.name }))
    .sort((a, b) => a.id - b.id)
}

const pickJa = <T extends { language: NamedResource }>(list: T[]) =>
  list.find((x) => x.language.name === 'ja-hrkt') ?? list.find((x) => x.language.name === 'ja')

export async function fetchDetail(id: number): Promise<PokemonDetail> {
  const [poke, species] = await Promise.all([
    getJson<{
      id: number
      name: string
      height: number
      weight: number
      types: { slot: number; type: NamedResource }[]
      stats: { base_stat: number; stat: NamedResource }[]
      sprites: { other: { 'official-artwork': { front_default: string | null } } }
      cries?: { latest: string | null }
    }>(`/pokemon/${id}`),
    getJson<{
      names: LocalizedName[]
      genera: { genus: string; language: NamedResource }[]
      flavor_text_entries: { flavor_text: string; language: NamedResource }[]
    }>(`/pokemon-species/${id}`),
  ])

  const jaName = pickJa(species.names)?.name ?? poke.name
  rememberJaName(id, jaName)
  const flavorEntries = species.flavor_text_entries.filter((f) => f.language.name.startsWith('ja'))

  return {
    id: poke.id,
    name: poke.name,
    jaName,
    genus: pickJa(species.genera)?.genus ?? '',
    flavor: (flavorEntries.at(-1)?.flavor_text ?? '').replace(/[\n\f　]+/g, ' '),
    types: poke.types.sort((a, b) => a.slot - b.slot).map((t) => t.type.name),
    stats: poke.stats.map((s) => s.base_stat),
    height: poke.height / 10,
    weight: poke.weight / 10,
    artwork:
      poke.sprites.other['official-artwork'].front_default ??
      `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`,
    cry: poke.cries?.latest ?? null,
  }
}

// ---------------------------------------------------------------- Japanese names
// PokeAPI has no bulk endpoint for localized names, so they are filled in lazily
// (a few requests at a time) and cached in localStorage per the fair-use policy.

function loadJaNames(): Record<number, string> {
  try {
    return JSON.parse(localStorage.getItem(JA_NAME_CACHE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

const jaNames: Record<number, string> = loadJaNames()
let saveTimer = 0

function rememberJaName(id: number, name: string) {
  if (jaNames[id] === name) return
  jaNames[id] = name
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(JA_NAME_CACHE_KEY, JSON.stringify(jaNames))
    } catch {
      // Storage unavailable (private mode etc.): names just won't persist.
    }
  }, 500)
}

export const getJaName = (id: number): string | undefined => jaNames[id]

/** Fetches missing Japanese names with limited concurrency, reporting progress. */
// Low concurrency on purpose: PokeAPI asks clients to keep request frequency down.
export async function fillJaNames(ids: number[], onUpdate: () => void, signal: AbortSignal, concurrency = 2) {
  const queue = ids.filter((id) => !jaNames[id])
  const worker = async () => {
    while (queue.length && !signal.aborted) {
      const id = queue.shift()!
      try {
        const s = await getJson<{ names: LocalizedName[] }>(`/pokemon-species/${id}`)
        const ja = pickJa(s.names)
        if (ja) rememberJaName(id, ja.name)
        onUpdate()
      } catch {
        // Skip; the English name stays as a fallback.
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
}

// ---------------------------------------------------------------- type colors

export const TYPE_COLORS: Record<string, [number, number, number]> = {
  normal: [0.66, 0.66, 0.47],
  fire: [0.94, 0.5, 0.19],
  water: [0.25, 0.56, 0.94],
  electric: [0.97, 0.82, 0.17],
  grass: [0.48, 0.78, 0.3],
  ice: [0.59, 0.85, 0.85],
  fighting: [0.76, 0.18, 0.16],
  poison: [0.64, 0.24, 0.63],
  ground: [0.89, 0.75, 0.4],
  flying: [0.66, 0.56, 0.95],
  psychic: [0.98, 0.33, 0.53],
  bug: [0.65, 0.73, 0.1],
  rock: [0.71, 0.63, 0.21],
  ghost: [0.45, 0.34, 0.59],
  dragon: [0.44, 0.21, 0.99],
  dark: [0.44, 0.34, 0.27],
  steel: [0.72, 0.72, 0.81],
  fairy: [0.84, 0.52, 0.68],
}

export const TYPE_JA: Record<string, string> = {
  normal: 'ノーマル',
  fire: 'ほのお',
  water: 'みず',
  electric: 'でんき',
  grass: 'くさ',
  ice: 'こおり',
  fighting: 'かくとう',
  poison: 'どく',
  ground: 'じめん',
  flying: 'ひこう',
  psychic: 'エスパー',
  bug: 'むし',
  rock: 'いわ',
  ghost: 'ゴースト',
  dragon: 'ドラゴン',
  dark: 'あく',
  steel: 'はがね',
  fairy: 'フェアリー',
}

export const toCss = ([r, g, b]: [number, number, number]) =>
  `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`
