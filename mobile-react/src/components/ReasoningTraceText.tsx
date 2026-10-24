import { useMemo } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useRecyclingState } from '@shopify/flash-list'
import type { Event } from '../types'
import { boundedTraceText, reasoningTraceLabel, reasoningTracePages, reasoningTraceText, reasoningTraceWindowTruncated } from '../lib/trace-detail'
import { reasoningItemKey } from '../lib/timeline-reasoning-stream'
import { useLanguageStore } from '../store/useLanguageStore'
import { t } from '../i18n'
import { fontWeight, radius, spacing, typography, usePalette } from '../theme'
import { Text } from './AppText'
import { MarkdownContent } from './MarkdownContent'

/** The available text stays reachable without mounting an unbounded timeline cell. */
export function ReasoningTraceText({ event, fontScale, profileGeneration }: { event: Event; fontScale: number; profileGeneration: number }) {
  const colors = usePalette()
  useLanguageStore(state => state.locale)
  const identity = reasoningItemKey(event)
  const [open, setOpen] = useRecyclingState(false, [profileGeneration, event.session_id, identity])
  const [page, setPage] = useRecyclingState(0, [profileGeneration, event.session_id, identity])
  const text = reasoningTraceText(event)
  const preview = useMemo(() => boundedTraceText(event), [event])
  const pages = useMemo(() => open ? reasoningTracePages(text) : [], [open, text])
  const selectedPage = Math.min(page, Math.max(0, pages.length - 1))
  const label = reasoningTraceLabel(event)
  const hasHiddenText = text.length > 0 && (text !== preview || reasoningTraceWindowTruncated(event))
  const buttonStyle = [styles.button, { backgroundColor: colors.raised, borderColor: colors.border }]
  const buttonText = [styles.buttonText, { color: colors.blue }]
  return <View style={styles.wrap}>
    <Text style={[styles.label, { color: colors.muted }]} localize>{label}</Text>
    {open ? <>
      <Text testID={`trace-event-page-${event.id}`} accessibilityLiveRegion="polite" style={[styles.page, { color: colors.muted }]}>{t('Plain text · Part {part} of {total}', { part: selectedPage + 1, total: pages.length })}</Text>
      <ScrollView
        key={`${identity}:${selectedPage}`}
        testID={`trace-event-reader-${event.id}`}
        accessibilityLabel={t('{label}, full available text', { label: t(label) })}
        nestedScrollEnabled
        style={[styles.reader, { borderColor: colors.border }]}
        contentContainerStyle={styles.readerContent}
      >
        <Text testID={`trace-event-content-${event.id}`} selectable style={[styles.fullText, { color: colors.text }]}>{pages[selectedPage]}</Text>
      </ScrollView>
      <View style={styles.controls}>
        <Pressable testID={`trace-event-prev-${event.id}`} accessibilityRole="button" accessibilityLabel={t('Previous part of {label}', { label: t(label).toLocaleLowerCase() })} accessibilityState={{ disabled: selectedPage === 0 }} disabled={selectedPage === 0} onPress={() => setPage(Math.max(0, selectedPage - 1))} style={[buttonStyle, styles.pageButton, { opacity: selectedPage === 0 ? 0.4 : 1 }]}><Text style={buttonText} localize>Previous</Text></Pressable>
        <Pressable testID={`trace-event-next-${event.id}`} accessibilityRole="button" accessibilityLabel={t('Next part of {label}', { label: t(label).toLocaleLowerCase() })} accessibilityState={{ disabled: selectedPage >= pages.length - 1 }} disabled={selectedPage >= pages.length - 1} onPress={() => setPage(Math.min(pages.length - 1, selectedPage + 1))} style={[buttonStyle, styles.pageButton, { opacity: selectedPage >= pages.length - 1 ? 0.4 : 1 }]}><Text style={buttonText} localize>Next</Text></Pressable>
      </View>
      <Pressable testID={`trace-event-close-${event.id}`} accessibilityRole="button" accessibilityLabel={t('Close full {label}', { label: t(label).toLocaleLowerCase() })} accessibilityState={{ expanded: true }} onPress={() => { setOpen(false); setPage(0) }} style={buttonStyle}><Text style={buttonText} localize>Close full text</Text></Pressable>
    </> : <>
      {hasHiddenText ? <Pressable testID={`trace-event-full-${event.id}`} accessibilityRole="button" accessibilityLabel={t('Read full available {label}', { label: t(label).toLocaleLowerCase() })} accessibilityState={{ expanded: false }} onPress={() => { setPage(0); setOpen(true) }} style={buttonStyle}><Text style={buttonText} localize>Read full available text</Text></Pressable> : null}
      {preview.trim() ? event.type === 'reasoning_text' || event.phase === 'reasoning'
        ? <Text selectable style={[styles.fullText, { color: colors.text }]}>{preview}</Text>
        : <MarkdownContent value={preview} fontScale={fontScale} /> : null}
    </>}
    {reasoningTraceWindowTruncated(event) ? <Text testID={`trace-event-window-${event.id}`} style={[styles.page, { color: colors.muted }]} localize>Only the available text window is shown. Some provider text was omitted.</Text> : null}
  </View>
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  label: { ...typography.caption, fontWeight: fontWeight.medium },
  page: { ...typography.caption },
  reader: { height: 300, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm },
  readerContent: { padding: spacing.md },
  fullText: { ...typography.body },
  controls: { flexDirection: 'row', gap: spacing.sm },
  button: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, paddingHorizontal: spacing.md, alignItems: 'center', justifyContent: 'center' },
  pageButton: { flex: 1 },
  buttonText: { ...typography.label, fontWeight: fontWeight.semibold },
})
