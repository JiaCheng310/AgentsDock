import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native'
import { Circle, CircleCheck, Code2, RefreshCw } from 'lucide-react-native'
import { SETTINGS_AGENTS, settingsAgentAvailable } from '../lib/settings-agents'
import { useAppStore } from '../store/useAppStore'
import { fontWeight, radius, spacing, typography, usePalette } from '../theme'
import { Text } from './AppText'
import { BackendMark } from './BackendMark'

export function MyAgentsSettings() {
  const profileId = useAppStore(state => state.activeProfileId)
  const generation = useAppStore(state => state.profileGeneration)
  return <ScopedMyAgentsSettings key={`${profileId}:${generation}`} />
}

function ScopedMyAgentsSettings() {
  const colors = usePalette()
  const health = useAppStore(state => state.health)
  const runtime = useAppStore(state => state.runtime)
  const connected = useAppStore(state => state.connected && !state.connecting && !state.switchingProfileId && !state.workspaceAdopting)
  const serverName = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.name)
  const refresh = useAppStore(state => state.refreshRuntime)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const recheck = async () => {
    if (!connected || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setFailed(false)
    try {
      await refresh()
      if (mounted.current) setFailed(Boolean(useAppStore.getState().error))
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return <View testID="settings-my-agents" style={styles.page}>
    <View style={styles.header}>
      <Text numberOfLines={1} style={[styles.serverName, { color: colors.muted }]}>{serverName || 'Server'}</Text>
      <Pressable testID="settings-agents-recheck" accessibilityRole="button" accessibilityLabel="Recheck agents" accessibilityState={{ busy, disabled: busy || !connected }} disabled={busy || !connected} onPress={() => void recheck()} style={({ pressed }) => [styles.recheck, { backgroundColor: colors.raised, opacity: !connected ? 0.4 : pressed ? 0.65 : 1 }]}>
        {busy ? <ActivityIndicator size="small" color={colors.muted} /> : <RefreshCw size={16} color={colors.muted} />}
        <Text style={[typography.label, { color: colors.text }]}>Recheck</Text>
      </Pressable>
    </View>
    <View>{SETTINGS_AGENTS.map(agent => {
      const available = connected && !failed && settingsAgentAvailable(health, runtime, agent.id)
      return <View key={agent.id} testID={`settings-agent-${agent.id}`} accessible accessibilityLabel={`${agent.name}, ${available ? 'available' : 'not available'}`} style={[styles.row, { borderColor: colors.border }]}>
        <View style={[styles.mark, !available && { opacity: 0.4 }]}>{agent.id === 'opencode' ? <Code2 size={22} color={colors.text} /> : <BackendMark backend={agent.id} size={22} />}</View>
        <Text style={[styles.name, { color: available ? colors.text : colors.muted }]}>{agent.name}</Text>
        {available ? <CircleCheck size={21} color={colors.green} /> : <Circle size={21} color={colors.muted} />}
      </View>
    })}</View>
    {!connected || failed ? <Text accessibilityRole="text" style={[typography.caption, { color: colors.muted }]}>{!connected ? 'Server offline' : 'Could not check agents. Try again.'}</Text> : null}
    <Text style={[typography.caption, { color: colors.muted }]}>Sign in on your server machine, not on mobile.</Text>
  </View>
}

const styles = StyleSheet.create({
  page: { gap: spacing.lg },
  header: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  serverName: { ...typography.label, fontWeight: fontWeight.medium, flex: 1 },
  recheck: { minHeight: 44, paddingHorizontal: spacing.md, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  row: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: spacing.md },
  mark: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  name: { ...typography.body, flex: 1 },
})
