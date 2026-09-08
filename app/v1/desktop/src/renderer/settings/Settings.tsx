import { useCallback, useEffect, useState } from 'react'
import type { RetainedAudio } from '../../shared/ipc.js'
import type { PausePreset, Settings as SettingsShape } from '../../shared/settings.js'
import { PAUSE_LABELS, applyPausePreset, pausePresetOf } from '../../shared/settings.js'
import { listInputs } from '../capture/mic.js'
import { DictionaryEditor } from './DictionaryEditor.js'
import { ConfirmButton, Choice, Row, Section, Toggle } from './Field.js'

/**
 * Everything a person can change, and nothing they cannot act on.
 *
 * TWO LEVELS, deliberately. The top section is what anyone needs: which
 * microphone, how long a pause ends a dictation, whether recordings are kept.
 * Developer mode reveals the rest - the dictionary, the cleanup switch, the
 * models - because those need an understanding of the pipeline to use well, and
 * putting them in front of someone who has just installed the app makes the
 * simple decisions harder to find.
 *
 * WHAT IS DELIBERATELY ABSENT. The dictation hotkey: changing it properly needs
 * a picker that knows which combinations Windows and other apps have already
 * taken, and offering a text field that silently fails to bind would be worse
 * than not offering it. The speech threshold: calibration owns those, and
 * hand-editing them is exactly how the original detection bug happened.
 */

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function MicrophonePicker({
  settings,
  save,
}: {
  settings: SettingsShape
  save(patch: Partial<SettingsShape>): void
}): React.JSX.Element {
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([])

  useEffect(() => {
    void listInputs()
      .then(setDevices)
      .catch(() => setDevices([]))
  }, [])

  // Labels are empty until microphone permission has been granted once. Saying
  // so beats rendering a list of blanks.
  const named = devices.filter((d) => d.label && d.deviceId !== 'communications')

  return (
    <select
      value={settings.audio.deviceId ?? ''}
      onChange={(e) => {
        const deviceId = e.target.value || null
        const deviceLabel = named.find((d) => d.deviceId === deviceId)?.label ?? ''
        save({ audio: { deviceId, deviceLabel } })
      }}
      className="max-w-[16rem] truncate rounded-md bg-neutral-950 px-2 py-1 text-[12px] text-neutral-200 ring-1 ring-white/10 outline-none focus:ring-white/25"
    >
      <option value="">System default</option>
      {named.map((d) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label}
        </option>
      ))}
      {/* A device that was chosen and is now unplugged must not vanish from the
          list, or the setting would silently appear to be "System default". */}
      {settings.audio.deviceId && !named.some((d) => d.deviceId === settings.audio.deviceId) && (
        <option value={settings.audio.deviceId}>
          {settings.audio.deviceLabel || 'Chosen device'} (not connected)
        </option>
      )}
    </select>
  )
}

function Recordings({ retain }: { retain: boolean }): React.JSX.Element {
  const [files, setFiles] = useState<RetainedAudio[]>([])
  const [open, setOpen] = useState(false)

  const load = useCallback((): void => {
    void window.wouice
      .getRecordings()
      .then((r) => setFiles([...r].sort((a, b) => b.at - a.at)))
      .catch(() => setFiles([]))
  }, [])

  useEffect(load, [load])

  const total = files.reduce((n, f) => n + f.bytes, 0)

  if (files.length === 0) {
    return (
      <span className="text-[11px] text-neutral-600">
        {retain ? 'Nothing kept yet' : 'Nothing kept'}
      </span>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-md px-2 py-1 text-[11px] text-neutral-400 ring-1 ring-white/10 hover:bg-white/5 hover:text-neutral-200"
      >
        {files.length} clips · {bytes(total)}
      </button>
      <ConfirmButton
        label="Delete all"
        confirmLabel={`Delete ${files.length}?`}
        onClick={() => void window.wouice.clearRecordings().then(load)}
      />
      {open && (
        <div className="absolute right-0 z-10 mt-2 w-72 translate-y-8 rounded-lg bg-neutral-950 p-1 shadow-xl ring-1 ring-white/15">
          <div className="max-h-56 overflow-y-auto">
            {files.map((f) => (
              <div key={f.file} className="flex items-center gap-2 px-2 py-1.5">
                <span className="flex-1 font-mono text-[10px] text-neutral-400">{when(f.at)}</span>
                <span className="font-mono text-[10px] text-neutral-600">{bytes(f.bytes)}</span>
                <ConfirmButton
                  label="×"
                  confirmLabel="Sure?"
                  onClick={() => void window.wouice.deleteRecording(f.file).then(load)}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function SettingsPanel({
  settings,
}: {
  settings: SettingsShape | null
}): React.JSX.Element | null {
  if (!settings) return null

  const save = (patch: Partial<SettingsShape>): void => {
    void window.wouice.setSettings(patch)
  }

  const preset = pausePresetOf(settings.silence)

  return (
    <div className="space-y-4">
      <Section title="Dictation">
        <Row
          label="Microphone"
          hint="Follows whatever Windows is using unless you pick one."
        >
          <MicrophonePicker settings={settings} save={save} />
        </Row>

        <Row
          label="Insert at the cursor"
          hint="Off means the text is only copied, and you paste it yourself. It is always copied either way."
        >
          <Toggle
            label="Insert at the cursor"
            on={settings.injection.enabled}
            onChange={(enabled) => save({ injection: { ...settings.injection, enabled } })}
          />
        </Row>

        <Row
          label="Stop when I pause for"
          hint={
            preset === 'custom'
              ? `Currently ${(settings.silence.shortWindowMs / 1000).toFixed(1)}s, hand-edited.`
              : 'How long a silence has to be before the recording ends.'
          }
        >
          <Choice<PausePreset>
            value={preset}
            options={(['quick', 'normal', 'relaxed'] as const).map((v) => ({
              value: v,
              label: PAUSE_LABELS[v],
            }))}
            onChange={(next) => save({ silence: applyPausePreset(settings.silence, next) })}
          />
        </Row>
      </Section>

      <Section
        title="Your voice on this disk"
        hint="Recordings never leave the machine. They exist so a bad transcription can be replayed rather than guessed at."
      >
        <Row label="Keep recent audio" hint="The last 20 dictations, oldest deleted first.">
          <Toggle
            label="Keep recent audio"
            on={settings.retainAudio}
            onChange={(retainAudio) => save({ retainAudio })}
          />
        </Row>
        <Row label="Kept now" hint="Delete any of them, or all at once.">
          <div className="relative">
            <Recordings retain={settings.retainAudio} />
          </div>
        </Row>
      </Section>

      <Section
        title="Advanced"
        hint="Off by default. Turning this on also reveals the models, the charts, and every stage of the text."
      >
        <Row
          label="Developer mode"
          hint="Shows what the pipeline did, so a wrong transcript can be diagnosed."
        >
          <Toggle
            label="Developer mode"
            on={settings.developerMode}
            onChange={(developerMode) => save({ developerMode })}
          />
        </Row>

        {settings.developerMode && (
          <Row
            label="Clean up with AI"
            hint="Off means you get the raw transcript: faster, no punctuation, and Hindi stays Hindi."
          >
            <Toggle
              label="Clean up with AI"
              on={settings.cleanup.enabled}
              onChange={(enabled) => save({ cleanup: { enabled } })}
            />
          </Row>
        )}
      </Section>

      {settings.developerMode && (
        <Section
          title="Dictionary"
          hint="Words this app gets wrong for you specifically. Rules apply before the AI cleanup, so a name fixed here stays fixed."
        >
          <div className="pt-3">
            <DictionaryEditor />
          </div>
        </Section>
      )}
    </div>
  )
}
