import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'

export type ReasoningDisplay = 'compact' | 'expanded'
const STORAGE_KEY = 'agentsdock.react.reasoningDisplay'
const normalize = (value: unknown): ReasoningDisplay => value === 'expanded' ? 'expanded' : 'compact'
let revision = 0
let hydration: Promise<void> | null = null
let persistence = Promise.resolve()

interface ReasoningDisplayState {
  preference: ReasoningDisplay
  hydrated: boolean
  error: string | null
  hydrate(): Promise<void>
  setPreference(value: ReasoningDisplay): Promise<void>
}

// Device-local presentation only. Never fetch a trace or mutate a server setting.
export const useReasoningDisplayStore = create<ReasoningDisplayState>((set, get) => ({
  preference: 'compact',
  hydrated: false,
  error: null,
  async hydrate() {
    if (get().hydrated) return
    if (hydration) return hydration
    const started = revision
    hydration = (async () => {
      try {
        const preference = normalize(await AsyncStorage.getItem(STORAGE_KEY))
        if (started === revision) set({ preference, hydrated: true, error: null })
      } catch {
        if (started === revision) set({ hydrated: true, error: 'Could not load the saved reasoning display.' })
      }
    })()
    try { await hydration } finally { hydration = null }
  },
  setPreference(value) {
    const preference = normalize(value)
    const started = ++revision
    set({ preference, hydrated: true, error: null })
    persistence = persistence.then(() => AsyncStorage.setItem(STORAGE_KEY, preference)).catch(() => {
      if (started === revision) set({ error: 'Could not save the reasoning display. Select it again to retry.' })
    })
    return persistence
  },
}))
