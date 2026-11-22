/** Where the handled ids are kept (AsyncStorage in the app, a stand-in in tests). */
export interface SeenStorage {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
}

export const SEEN_KEY = 'jophiel.actions.seen'
export const SEEN_KEEP = 50

/**
 * `claim(id)`: true the first time an id is seen, here or in an earlier run of the app (a push
 * that arrived after the app was swiped away and opened again). Marked before any await, so a
 * frame and a push racing in the same runtime can't both pass; the stored list is updated one
 * claim after another, so two different ids claimed together are both kept.
 */
export function seenIds(storage: SeenStorage): (actionId: string) => Promise<boolean> {
  const seen = new Set<string>()
  let stored: string[] | null = null
  let writes: Promise<unknown> = Promise.resolve()

  async function load(): Promise<string[]> {
    if (stored) return stored
    try {
      const raw = await storage.getItem(SEEN_KEY)
      const ids: unknown = raw ? JSON.parse(raw) : []
      stored = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
    } catch {
      stored = []
    }
    return stored
  }

  return (actionId) => {
    if (seen.has(actionId)) return Promise.resolve(false)
    seen.add(actionId)
    const turn = writes.then(async () => {
      const ids = await load()
      if (ids.includes(actionId)) return false
      stored = [...ids, actionId].slice(-SEEN_KEEP)
      await storage.setItem(SEEN_KEY, JSON.stringify(stored)).catch(() => {})
      return true
    })
    writes = turn.catch(() => {})
    return turn
  }
}
