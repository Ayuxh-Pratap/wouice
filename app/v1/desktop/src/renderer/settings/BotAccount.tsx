import { useEffect, useState } from 'react'
import type { BotStatusView } from '../../shared/ipc.js'
import type { Settings } from '../../shared/settings.js'
import { Row, Section } from './Field.js'

/**
 * The meeting bot's account, and whether its Chrome is signed in to it.
 *
 * SIGNED IN BY HAND, CHECKED BY WOUICE. Google refuses sign-in inside
 * automated browsers, so "Sign in" opens ordinary Chrome on the bot's own
 * profile and you sign in there yourself. Closing that window is the signal:
 * Wouice then opens the profile without a window and reads which account it
 * holds. Nothing here ever sees or types a password.
 */

const LABELS: Record<BotStatusView['state'], string> = {
  unknown: 'Not checked',
  checking: 'Checking…',
  'signing-in': 'Signing in…',
  'signed-in': 'Signed in',
  'wrong-account': 'Wrong account',
  'signed-out': 'Not signed in',
  'no-chrome': 'No Chrome',
  'profile-busy': 'Profile open',
  failed: 'Check failed',
}

function colour(status: BotStatusView): string {
  switch (status.state) {
    case 'signed-in':
      return status.email ? '#34d399' : '#fbbf24'
    case 'wrong-account':
    case 'signed-out':
    case 'profile-busy':
      return '#fbbf24'
    case 'no-chrome':
    case 'failed':
      return '#f87171'
    default:
      return '#737373'
  }
}

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function BotAccountSection({
  settings,
  save,
}: {
  settings: Settings
  save(patch: Partial<Settings>): void
}): React.JSX.Element {
  const [status, setStatus] = useState<BotStatusView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    void window.wouice.getBotStatus().then(setStatus)
    return window.wouice.onBotStatus(setStatus)
  }, [])

  const busy = status?.state === 'checking' || status?.state === 'signing-in'
  const detail = status
    ? [
        status.message,
        status.chromeVersion ? `Chrome ${status.chromeVersion}` : '',
        status.checkedAt ? `checked ${when(status.checkedAt)}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : ''

  return (
    <Section
      title="Meeting bot"
      hint="A Google account of its own that joins your meetings and keeps Meet's captions, with a name on every line. It lives in a separate Chrome profile nothing else uses. Never sign it in with your own account: Meet gets confused when one account is in a meeting twice."
    >
      <Row
        label="Bot's Google account"
        hint="The account the bot signs in as. What its profile actually holds is checked against this."
      >
        <input
          type="email"
          defaultValue={settings.meetings.bot.email}
          placeholder="yourbot@gmail.com"
          spellCheck={false}
          // On blur, like the other text fields here: each save rewrites the
          // settings file and pushes to every window.
          onBlur={(e) => {
            const email = e.target.value.trim().toLowerCase()
            if (email === settings.meetings.bot.email) return
            save({ meetings: { ...settings.meetings, bot: { email } } })
            // Handled after the save, in order: the status is re-read against
            // the new account without launching anything.
            void window.wouice.getBotStatus().then(setStatus)
          }}
          className="w-56 rounded-md bg-neutral-950 px-2 py-1 text-[12px] text-neutral-200 ring-1 ring-white/10 outline-none placeholder:text-neutral-700 focus:ring-white/25"
        />
      </Row>

      <Row
        label="Signed in"
        hint={
          detail ||
          "Sign in opens Chrome on the bot's profile. Sign in as the bot there, skip Chrome sync if it asks, and close the window: Wouice checks by itself."
        }
      >
        {status ? (
          <span
            className="flex items-center gap-1.5 text-[12px]"
            style={{ color: colour(status) }}
            title={status.email ?? undefined}
          >
            <span
              className={`size-1.5 rounded-full ${busy ? 'animate-pulse' : ''}`}
              style={{ backgroundColor: colour(status) }}
            />
            {status.state === 'signed-in' && status.email ? status.email : LABELS[status.state]}
          </span>
        ) : null}
        <button
          onClick={() => {
            setProblem(null)
            void window.wouice.openBotSignIn().then(setProblem)
          }}
          disabled={busy}
          className="rounded-md px-2.5 py-1 text-[11px] text-neutral-300 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-100 disabled:opacity-40"
        >
          Sign in…
        </button>
        <button
          onClick={() => void window.wouice.checkBot().then(setStatus)}
          disabled={busy}
          className="rounded-md px-2.5 py-1 text-[11px] text-neutral-300 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-100 disabled:opacity-40"
        >
          Check
        </button>
      </Row>

      {problem ? <p className="py-2 text-[11.5px] text-amber-400">{problem}</p> : null}
    </Section>
  )
}
