import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = fs.readFileSync(path.resolve('src/components/ServerProfiles.tsx'), 'utf8')
const appShell = fs.readFileSync(path.resolve('src/components/AppShell.tsx'), 'utf8')
const dialogs = fs.readFileSync(path.resolve('src/components/Dialogs.tsx'), 'utf8')
const firstLaunch = fs.readFileSync(path.resolve('src/lib/first-launch.ts'), 'utf8')
const store = fs.readFileSync(path.resolve('src/store/useAppStore.ts'), 'utf8')

test('first launch presents setup without probing localhost and hands off after dismissal', () => {
  assert.match(firstLaunch, /state\.initialized[\s\S]*?!state\.connected[\s\S]*?isServerSetupRequired\(state\)[\s\S]*?!state\.setupDismissed/)
  assert.match(store, /if \(NativeAppState\.currentState === 'active' && shouldAutoConnectServer\(get\(\)\)\) \{[\s\S]*?await get\(\)\.reconnect\(\)/)
  assert.match(store, /async reconnect\(\) \{\s*if \(NativeAppState\.currentState !== 'active' \|\| !shouldAutoConnectServer\(get\(\)\)\) return/)
  assert.match(appShell, /shouldPresentServerSetup\(\{ initialized, connected, serverConfigured, serverURL, setupDismissed \}\)/)
  assert.match(appShell, /setupNextMode\.current = 'edit-active'/)
  assert.match(appShell, /onDidDismiss=\{finishSetupDismissal\}/)
  assert.match(appShell, /if \(Platform\.OS !== 'ios'\) requestAnimationFrame\(finishSetupDismissal\)/)
  assert.doesNotMatch(appShell, /openServersAfterSetup/)
  assert.match(dialogs, /onDismiss=\{didDismiss\}/)
  assert.match(source, /initialServerProfileDraft\(initialMode, profiles, activeProfileId\)/)
})

test('server selector is a compact outlined button that opens the sheet directly', () => {
  const trigger = source.slice(source.indexOf('export function ServerProfileSelector'), source.indexOf('export function ServerProfilesSheet'))
  assert.match(trigger, /testID="server-profile-selector"/)
  assert.match(trigger, /styles\.selectorName, \{ color: colors\.text \}/)
  assert.match(trigger, /<ServerConnectionDot state=\{switchingProfileId \? 'connecting' : active\?\.connectionState \?\? 'cached'\}/)
  assert.match(trigger, /numberOfLines=\{1\} ellipsizeMode="tail"/)
  assert.match(trigger, /switching\?\.name \|\| active\?\.name \|\| 'Choose server'/)
  assert.doesNotMatch(trigger, /ServerUnreadBadge|MenuView|selectorHost/)
  assert.match(trigger, /return <Pressable/)
  assert.match(trigger, /onPress=\{onPress\}/)
  assert.match(trigger, /borderColor: colors\.controlBorder/)
  assert.match(trigger, /backgroundColor: pressed \? colors\.raised : colors\.controlSurface/)
  assert.match(source, /selectorName: \{ \.\.\.typography\.label, flexShrink: 1, minWidth: 0, fontWeight: fontWeight\.semibold \}/)
  assert.match(source, /selector: \{[^\n]*borderRadius: radius\.round[^\n]*borderWidth: 1/)
})

test('server name reserves a stable refresh indicator slot without disabling server switching', () => {
  assert.match(source, /refreshing\?: boolean/)
  assert.match(source, /refreshing = false/)
  assert.match(source, /<Text style=\{\[styles\.selectorName[\s\S]*?<View style=\{styles\.selectorRefresh\} pointerEvents="none">\s*\{refreshing \? <ActivityIndicator testID="server-chat-refresh"/)
  assert.match(source, /selectorRefresh: \{ width: 20, height: 20, flexShrink: 0/)
  assert.match(source, /busy: Boolean\(switchingProfileId\) \|\| refreshing/)
  assert.match(source, /const unavailable = disabled \|\| Boolean\(switchingProfileId\)/)
  assert.match(source, /refreshing \? ' Refreshing chats\.'/)
})

test('server title respects its container width without shrinking the hit height', () => {
  assert.match(source, /selector: \{ minHeight: 44, minWidth: 0, maxWidth: '100%', alignSelf: 'flex-start'/)
  assert.doesNotMatch(source, /selectorWidth|setSelectorWidth/)
})

test('server drawer starts with tappable rows and add, keeping management behind row actions', () => {
  assert.match(source, /stackPresentation="formSheet"/)
  assert.match(source, /!draft \? <View testID="server-profile-list">/)
  assert.match(source, /testID="server-profile-add"/)
  assert.match(source, /testID=\{`server-profile-switch-\$\{profile\.id\}`\}/)
  assert.match(source, /accessibilityState=\{\{ selected: active, disabled, busy: switching \}\}/)
  assert.match(source, /id: 'edit'[\s\S]*?onEdit\(\)/)
  assert.doesNotMatch(source, /Saved servers|Each server keeps|Switching replaces|`Identity:|>Active<|label=\{switching \? 'Using/)
})

test('native server sheet stays mounted through dismissal and reopens at its half-height detent', () => {
  assert.match(source, /const serverSheetDetents = \[0\.5, 1\]/)
  assert.match(source, /sheetInitialDetentIndex=\{0\}/)
  assert.match(source, /sheetGrabberVisible/)
  assert.match(source, /sheetExpandsWhenScrolledToEdge/)
  assert.match(source, /automaticallyAdjustKeyboardInsets=\{false\}/)
  assert.match(source, /pointerEvents=\{visible \? 'box-none' : 'none'\}/)
  assert.doesNotMatch(appShell, /key=\{`servers:/)
  assert.doesNotMatch(source, /styles\.grabber/)
})

test('server switching tracks resolved and thrown failures without swallowing the error', () => {
  const switchCallback = appShell.match(/const switchServer = useCallback\(async \(profileId: string\) => \{[\s\S]*?\n  \}, \[switchServerProfile\]\)/)?.[0]
  assert.ok(switchCallback)
  assert.match(switchCallback, /const success = await switchServerProfile\(profileId\)[\s\S]*?trackEvent\('server_switched', \{ success \}\)[\s\S]*?return success/)
  assert.match(switchCallback, /catch \(error\) \{[\s\S]*?trackEvent\('server_switched', \{ success: false \}\)[\s\S]*?throw error/)
})

test('new profiles stay gated on a successful connection test', () => {
  assert.match(source, /if \(!draft\.profileId && !tested\?\.ok\)/)
  assert.match(source, /\(!draft\.profileId && !tested\?\.ok\)/)
  assert.match(source, /did not report a stable server identity/)
  assert.match(source, /Already saved as/)
})

test('connection edits carry only the freshly tested identity', () => {
  assert.match(source, /updateConnectionChanged && !tested\?\.server_identity\?\.trim\(\)/)
  assert.match(source, /buildUpdateServerProfileInput\(editedProfile, draft, tested\?\.server_identity\)/)
  assert.match(source, /identityResetUnconfirmed/)
})

test('server removal and identity reset require native confirmation', () => {
  assert.match(source, /Alert\.alert\([\s\S]*?Remove server/)
  assert.match(source, /Alert\.alert\([\s\S]*?Allow identity reset/)
  assert.match(source, /attributes: \{ disabled: disabled \|\| active, destructive: !active \}/)
})

test('server management controls retain touch-safe minimum dimensions', () => {
  assert.match(source, /input: \{ \.\.\.typography\.body, minHeight: 44/)
  assert.match(source, /primaryButton: \{ minHeight: 44/)
  assert.match(source, /secondaryButton: \{ minHeight: 44/)
  assert.match(source, /moreButton: \{ width: 44, height: 44/)
})
