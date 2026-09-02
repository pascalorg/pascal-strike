/**
 * Typed event bus (W1-A).
 *
 * Handlers may subscribe/unsubscribe while an event is being emitted: emit iterates a
 * snapshot of the handler list, so mutations only affect the next emit.
 */
import type { EventBus, EventKey, GameEventMap } from '../types'

type AnyHandler = (payload: never) => void

export function createEventBus(): EventBus {
  const handlers = new Map<EventKey, Set<AnyHandler>>()

  return {
    on<K extends EventKey>(key: K, handler: (payload: GameEventMap[K]) => void): () => void {
      let set = handlers.get(key)
      if (!set) {
        set = new Set()
        handlers.set(key, set)
      }
      const fn = handler as AnyHandler
      set.add(fn)
      return () => {
        handlers.get(key)?.delete(fn)
      }
    },

    emit<K extends EventKey>(key: K, payload: GameEventMap[K]): void {
      const set = handlers.get(key)
      if (!set || set.size === 0) return
      // Snapshot so a handler can unsubscribe itself (or others) mid-emit.
      const list = Array.from(set) as ((payload: GameEventMap[K]) => void)[]
      for (let i = 0; i < list.length; i++) {
        try {
          list[i](payload)
        } catch (err) {
          // One bad listener must not break the rest of the frame.
          console.error(`[events] handler for "${key}" threw`, err)
        }
      }
    },
  }
}
