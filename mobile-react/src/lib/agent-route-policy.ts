import type { AgentCrossChatRoute, AgentCrossChatRoutesSnapshot, ChatReference } from '../types'

function isFiniteRouteLimit(maximum: number | null): maximum is number {
  return typeof maximum === 'number' && Number.isSafeInteger(maximum) && maximum >= 0
}

function pendingRouteTargets(granted: ReadonlySet<string>, references: readonly ChatReference[]): Set<string> {
  return new Set(references.flatMap(reference => (
    reference.target_kind !== 'secure_peer' && reference.action === 'route' && reference.grant_intent === true && !granted.has(reference.session_id)
      ? [reference.session_id] : []
  )))
}

/** Unlimited metadata is null, not zero. Existing and pending targets use no new slot. */
export function routeCapacityReached(routes: readonly AgentCrossChatRoute[], maximum: number | null, references: readonly ChatReference[], targetId?: string): boolean {
  if (!isFiniteRouteLimit(maximum)) return false
  const granted = new Set(routes.map(route => route.target_session_id))
  const pending = pendingRouteTargets(granted, references)
  if (targetId && (granted.has(targetId) || pending.has(targetId))) return false
  return routes.length + pending.size >= maximum
}

/** Count only explicit new grants; repeated references never invent extra routes. */
export function agentRouteCapacityError(snapshot: AgentCrossChatRoutesSnapshot | undefined, references: readonly ChatReference[]): string | null {
  if (!snapshot || !isFiniteRouteLimit(snapshot.max_routes)) return null
  const granted = new Set(snapshot.routes.map(route => route.target_session_id))
  const pending = pendingRouteTargets(granted, references)
  if (pending.size === 0) return null
  return snapshot.routes.length + pending.size > snapshot.max_routes
    ? `This chat has reached its route access limit (${snapshot.max_routes} ${snapshot.max_routes === 1 ? 'route' : 'routes'} maximum). Revoke a granted route before adding another chat.`
    : null
}

export function isAgentRouteRevisionConflict(error: { status?: unknown; detail?: unknown }): boolean {
  if (error.status !== 409) return false
  if (error.detail === 'route revision conflict') return true
  return Boolean(error.detail && typeof error.detail === 'object' && !Array.isArray(error.detail)
    && (error.detail as { code?: unknown }).code === 'route_revision_conflict')
}
