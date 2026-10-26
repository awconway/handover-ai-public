import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { render } from 'remix/component/test'

import { routes } from '../../app/routes.ts'
import { AppShell, PrivacySettingsPage } from '../../app/ui/index.ts'

describe('audio privacy settings UI', () => {
  it('renders an accessible optional deidentification preference for future jobs', () => {
    let result = render(<PrivacySettingsPage
      action={routes.settings.privacy.action.href()}
      csrfToken="csrf-token"
      homeHref={routes.workspace.home.href()}
      policy="optional"
      userEnabled={false}
      effectiveMode="cloud"
      editable
    />)

    try {
      let form = result.$(`form[action="${routes.settings.privacy.action.href()}"]`)
      let toggle = result.$('input[role="switch"]') as HTMLInputElement | null
      let label = result.$('label[for="local-first-processing-enabled"]')
      assert.ok(form)
      assert.equal(form?.querySelector('input[name="_csrf"]')?.getAttribute('value'), 'csrf-token')
      assert.ok(toggle)
      assert.equal(toggle?.checked, false)
      assert.equal(toggle?.disabled, false)
      assert.equal(toggle?.getAttribute('aria-describedby'), 'local-first-help')
      assert.ok(label)
      assert.match(label?.textContent ?? '', /Deidentify before cloud analysis/)
      assert.match(result.container.textContent ?? '', /Audio is always transcribed locally/)
      assert.match(result.container.textContent ?? '', /Changes apply to future jobs/)
    } finally {
      result.cleanup()
    }
  })

  it('keeps deployment-required and deployment-disabled modes visible but not editable', () => {
    for (let state of [
      { policy: 'required' as const, effectiveMode: 'local-first' as const, checked: true, copy: 'Required by deployment' },
      { policy: 'disabled' as const, effectiveMode: 'cloud' as const, checked: false, copy: 'Disabled by deployment' },
    ]) {
      let result = render(<PrivacySettingsPage
        action={routes.settings.privacy.action.href()}
        homeHref={routes.workspace.home.href()}
        policy={state.policy}
        userEnabled={!state.checked}
        effectiveMode={state.effectiveMode}
        editable={false}
      />)
      try {
        let toggle = result.$('input[role="switch"]') as HTMLInputElement | null
        let submit = result.$('button[type="submit"]') as HTMLButtonElement | null
        assert.equal(toggle?.checked, state.checked)
        assert.equal(toggle?.disabled, true)
        assert.equal(submit?.disabled, true)
        assert.match(result.container.textContent ?? '', new RegExp(state.copy))
      } finally {
        result.cleanup()
      }
    }
  })

  it('shows local transcription in both privacy modes and links to privacy settings', () => {
    for (let privacyMode of ['local-first', 'cloud'] as const) {
      let result = render(<AppShell
        currentUserId="user-1"
        mode="individual"
        homeHref={routes.workspace.home.href()}
        switchHref={routes.workspace.shiftSelection.href()}
        inboxHref={routes.workspace.inbox.href()}
        inboxCount={0}
        privacySettingsHref={routes.settings.privacy.index.href()}
        privacyMode={privacyMode}
        signInHref={routes.auth.signIn.index.href()}
        signOutAction={routes.auth.signOut.href()}
      />)

      try {
        let status = result.$('[data-testid="privacy-status-link"]')
        assert.equal(status?.getAttribute('href'), routes.settings.privacy.index.href())
        assert.equal(status?.getAttribute('aria-label'), `Audio privacy settings, local transcription active, deidentification ${privacyMode === 'local-first' ? 'on' : 'off'}`)
        assert.match(status?.textContent ?? '', /Audio: Local/)
      } finally {
        result.cleanup()
      }
    }
  })
})
