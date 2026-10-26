import type { Event } from '../types'

/** An accepted human follow-up within the existing native Codex goal run. */
export function isNativeGoalSteerEvent(event: Event): boolean {
  return event.type === 'turn_steered'
    && event.native_goal_steer === true
    && event.native_steer === true
    && event.backend === 'codex'
    && event.purpose === 'codex_goal_resume'
    && event.provider_user_authored === true
    && typeof event.run_id === 'string'
    && Boolean(event.run_id.trim())
}
