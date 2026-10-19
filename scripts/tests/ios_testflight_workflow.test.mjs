import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../../.github/workflows/ios-testflight.yml', import.meta.url), 'utf8')

test('upload requires manual canonical hosted dispatch with an exact reviewed source pin', () => {
  assert.match(workflow, /if: github.event_name == 'workflow_dispatch' && github.repository == 'ZhengyiLuo\/AgentsDock'/)
  assert.match(workflow, /environment: direct-production/)
  assert.match(workflow, /runs-on: macos-26/)
  assert.match(workflow, /test "\$RUNNER_ENVIRONMENT" = github-hosted/)
  assert.match(workflow, /test "\$SOURCE_SHA" = "\$GITHUB_SHA"/)
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.doesNotMatch(workflow, /(?:contents|packages|actions): write/)
})

test('production build validates native changes before upload and never submits App Store review', () => {
  assert.match(workflow, /AGENTSDOCK_APP_VARIANT: production/)
  assert.match(workflow, /pnpm install --frozen-lockfile/)
  assert.match(workflow, /pnpm verify:ios-native/)
  assert.match(workflow, /pnpm verify:ios-archive-abi/)
  assert.doesNotMatch(workflow, /RCT_SYMBOLICATE_PREBUILT_FRAMEWORKS/)
  assert.match(workflow, /reactnative-core-dSYM-release.tar.gz/)
  assert.match(workflow, /collect-ios-archive-symbols.mjs/)
  assert.match(workflow, /test -s "\$APP\/main.jsbundle"/)
  assert.match(workflow, /DEVELOPMENT_TEAM=KRR35MWWHD CODE_SIGN_STYLE=Automatic archive/)
  assert.ok(workflow.indexOf('Validate archive metadata') < workflow.indexOf('Cloud sign and upload'))
  assert.equal((workflow.match(/ios-testflight-metadata.mjs check/g) ?? []).length, 2)
  assert.match(workflow, /ios-testflight-metadata.mjs wait/)
  assert.doesNotMatch(workflow, /appStoreVersionSubmissions|reviewSubmissions|betaAppReviewSubmissions|gh release|npm publish|upload-artifact/)
})

test('Apple credentials are step-local and disposable, not package-manager environment', () => {
  const install = workflow.split('name: Install locked dependencies')[1].split('      - name:')[0]
  assert.doesNotMatch(install, /secrets\.|APPLE_API/)
  assert.match(workflow, /mode: 0o600/)
  assert.match(workflow, /always\(\) && steps.key.outputs.directory != ''/)
  assert.match(workflow, /assert.ok\(!lstatSync\(directory\).isSymbolicLink\(\)\)/)
  assert.match(workflow, /assert.equal\(dirname\(realpathSync\(directory\)\), realpathSync\(process.env.RUNNER_TEMP\)\)/)
  assert.doesNotMatch(workflow, /MACOS_CERTIFICATE|AGENTSDOCK_RELEASE_TOKEN|set -x|--apple-id|--password/)
})

test('inline shell and JavaScript parse without running signing or upload', () => {
  const bodies = [...workflow.matchAll(/^        run: \|\n((?:          .*\n|\n)+)/gm)].map(match => match[1].split('\n').map(line => line.slice(10)).join('\n'))
  assert.equal(bodies.length, 9)
  for (const body of bodies) {
    const bash = spawnSync('/bin/bash', ['--noprofile', '--norc', '-n'], { input: body, encoding: 'utf8' })
    assert.equal(bash.status, 0, bash.stderr)
    const js = body.match(/node --input-type=module <<'JS'\n([^]*?)\nJS(?:\n|$)/)?.[1]
    if (js) {
      const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: js, encoding: 'utf8' })
      assert.equal(syntax.status, 0, syntax.stderr)
    }
  }
})
