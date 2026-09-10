import { useCallback, useEffect, useState } from 'react'
import type { RetainedAudio } from '../../shared/ipc.js'
import type { PausePreset, Settings as SettingsShape } from '../../shared/settings.js'
import {
  PAUSE_LABELS,
  ZOOM_STEPS,
  applyPausePreset,
  pausePresetOf,
  zoomLabel,
} from '../../shared/settings.js'
import { listInputs } from '../capture/mic.js'
import { CHARACTER_LIST, posterStyle } from '../hud/sprite.js'
import { PET_SIZE_LABELS, type PetSize } from '../../shared/pet.js'
import { BotAccountSection } from './BotAccount.js'
import { DictionaryEditor } from './DictionaryEditor.js'
import { ConfirmButton, Choice, Row, Section, Toggle } from './Field.js'
import { Tabs } from '../shell/Tabs.js'
import { MEETING_KINDS, type MeetingKind } from '../../shared/meeting-kind.js'
// The types entry, NOT the package root. The root pulls in `node:sqlite`, which
// cannot exist in a renderer: importing a runtime value from it broke the
// renderer bundle outright, and it failed silently enough that only a count of
// "built in" lines caught it.
import { TASK_AREAS, type TaskArea } from '@wouice/store/types'

/**
 * Settings, grouped by what you came to change.
 *
 * One long column meant scrolling past four things you did not want to reach
 * the one you did. These are the groups people actually arrive with in mind.
 */
type SettingsTab = 'appearance' | 'dictation' | 'meetings' | 'storage' | 'advanced'

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'dictation', label: 'Dictation' },
  { id: 'meetings', label: 'Meetings' },
  { id: 'storage', label: 'Recordings' },
  { id: 'advanced', label: 'Advanced' },
]

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

/**
 * Starting over.
 *
 * WHY IT IS HERE AND NOT ONLY IN THE TABLE. Selecting rows is for removing a
 * few; this is for the different intent of "none of this should exist any
 * more", and someone with 1,300 dictations cannot express that by ticking
 * boxes. It takes the retained audio with it, because a reset that leaves the
 * recordings behind has not reset anything that matters.
 *
 * Deliberately NOT behind developer mode. Deleting your own voice from your own
 * disk is not an advanced operation.
 */
function DeleteEverything(): React.JSX.Element {
  const [count, setCount] = useState<number | null>(null)

  const load = useCallback((): void => {
    void window.wouice
      .getStorage()
      .then((s) => setCount(s.tables.find((t) => t.name === 'dictations')?.rows ?? 0))
      .catch(() => setCount(null))
  }, [])

  useEffect(load, [load])
  // The table and the charts already refresh on this; so should the count.
  useEffect(() => window.wouice.onMetric(load), [load])

  if (count === null) return <span className="text-[11px] text-neutral-600">Unavailable</span>
  if (count === 0) return <span className="text-[11px] text-neutral-600">Nothing to delete</span>

  return (
    <ConfirmButton
      label={`Delete all ${count.toLocaleString()}`}
      confirmLabel="Delete everything?"
      onClick={() => void window.wouice.clearDictations().then(load)}
    />
  )
}

/**
 * Which character sits on the desktop.
 *
 * Shown as the characters themselves rather than a dropdown of names: the only
 * thing anybody is choosing between here is what they look like, and a list
 * reading "Kim / Mai / Summer" asks you to remember which is which.
 *
 * The first frame of each idle row, held still. Animating all three at once in
 * a settings screen would be three sprite loops running for a decision that
 * takes two seconds.
 */
function CharacterPicker({
  settings,
  save,
}: {
  settings: SettingsShape
  save(patch: Partial<SettingsShape>): void
}): React.JSX.Element {
  return (
    <div className="flex gap-2">
      {CHARACTER_LIST.map((c) => {
        const chosen = settings.pet.character === c.id
        return (
          <button
            key={c.id}
            onClick={() => save({ pet: { ...settings.pet, character: c.id } })}
            title={c.name}
            aria-pressed={chosen}
            className={[
              'grid place-items-end justify-items-center rounded-lg px-1 pt-1 transition',
              chosen
                ? 'lift-active bg-white/[0.09] ring-1 ring-white/20'
                : 'bg-black/20 opacity-60 ring-1 ring-white/[0.06] hover:opacity-100',
            ].join(' ')}
          >
            <span
              style={{ ...posterStyle(c, 52), imageRendering: 'pixelated' }}
              className="bg-no-repeat"
            />
            <span className="pb-0.5 text-[10px] text-neutral-400">{c.name}</span>
          </button>
        )
      })}
    </div>
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
  // Shown only after switching her on in this session; there is nothing to warn
  // about when she was already there at startup.
  const [justEnabled, setJustEnabled] = useState(false)

  if (!settings) return null

  const [tab, setTab] = useState<SettingsTab>('appearance')

  const save = (patch: Partial<SettingsShape>): void => {
    void window.wouice.setSettings(patch)
  }

  const preset = pausePresetOf(settings.silence)

  return (
    <div className="space-y-4">
      <Tabs<SettingsTab> tabs={SETTINGS_TABS} active={tab} onChange={setTab} />

      {tab === 'appearance' && <div className="space-y-4">
      <Section
        title="Appearance"
        hint="Applies to this window only. The dictation overlay is a fixed size wherever it appears."
      >
        <Row
          label="Interface scale"
          hint="For large monitors, where the pixels are there but the reading distance is not. Ctrl+= and Ctrl+- do the same thing from anywhere."
        >
          {/* Values are percentages in the UI and a multiplier underneath. The
              control speaks the first language. */}
          <Choice<string>
            value={String(settings.appearance.zoom)}
            options={ZOOM_STEPS.map((z) => ({ value: String(z), label: zoomLabel(z) }))}
            onChange={(next) => save({ appearance: { zoom: Number(next) } })}
          />
        </Row>
      </Section>
      </div>}

      {tab === 'dictation' && <div className="space-y-4">
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
          label="Keep the pet on the desktop"
          hint={
            justEnabled
              ? 'She is there, but will not take a click or a drag until the app is restarted. Known, and not yet fixed.'
              : 'A small character you can park anywhere and click to dictate. Off means the overlay only appears while it is working, along the bottom of the screen.'
          }
        >
          <Toggle
            label="Keep the pet on the desktop"
            on={settings.pet.enabled}
            onChange={(enabled) => {
              // Switching her ON mid-session leaves her unclickable until a
              // restart. The cause is not found, and two attempts at fixing it
              // were removed rather than left in place pretending. Saying so
              // here costs nothing and is at least true.
              setJustEnabled(enabled && !settings.pet.enabled)
              save({ pet: { ...settings.pet, enabled } })
            }}
          />
        </Row>

        {settings.pet.enabled && (
          <Row label="Character" hint="Click her to dictate, drag her anywhere.">
            <CharacterPicker settings={settings} save={save} />
          </Row>
        )}

        {settings.pet.enabled && (
          <Row
            label="How big"
            hint="The drawings do not all fill the same amount of their frame, so what looks right differs between them - and between a laptop panel and a large monitor."
          >
            <Choice<PetSize>
              value={settings.pet.size}
              options={(['small', 'medium', 'large', 'huge'] as const).map((v) => ({
                value: v,
                label: PET_SIZE_LABELS[v],
              }))}
              onChange={(size) => save({ pet: { ...settings.pet, size } })}
            />
          </Row>
        )}

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
      </div>}

      {tab === 'meetings' && <div className="space-y-4">
      <Section
        title="Meetings"
        hint="Two channels, kept apart by where the audio comes from rather than by a model: your microphone is you, and what your computer plays is everyone else."
      >
        <Row
          label="Usually"
          hint="What the next meeting starts as. Each meeting keeps its own kind and can be changed on its own page — client calls in English and the team standup in Hindi are both a normal week. Naming the language matters more than any other setting here: one recorded meeting left to detect came back as Icelandic, Japanese, Spanish and English in turn."
        >
          <Choice
            value={settings.meetings.defaultKind}
            options={MEETING_KINDS.map((k) => ({ value: k.id, label: k.label }))}
            onChange={(kind) =>
              save({ meetings: { ...settings.meetings, defaultKind: kind as MeetingKind } })
            }
          />
        </Row>

        <Row
          label="Your name"
          hint="How people say it in your meetings. A task given to you by name — 'Ayush, can you take the login bug' — is marked as yours."
        >
          <input
            defaultValue={settings.meetings.me.name}
            placeholder="Ayush"
            // On blur, not on every keystroke: each save rewrites the file and
            // pushes new settings to every window.
            onBlur={(e) => {
              const name = e.target.value.trim()
              if (name === settings.meetings.me.name) return
              save({ meetings: { ...settings.meetings, me: { ...settings.meetings.me, name } } })
            }}
            className="w-40 rounded-md bg-neutral-950 px-2 py-1 text-[12px] text-neutral-200 ring-1 ring-white/10 outline-none placeholder:text-neutral-700 focus:ring-white/25"
          />
        </Row>

        <Row
          label="Your area"
          hint="Which part of the work you want surfaced first. It becomes a filter on every meeting's task list."
        >
          <select
            value={settings.meetings.me.area}
            onChange={(e) =>
              save({
                meetings: {
                  ...settings.meetings,
                  me: { ...settings.meetings.me, area: e.target.value as TaskArea },
                },
              })
            }
            className="rounded-md bg-neutral-950 px-2 py-1 text-[12px] text-neutral-200 ring-1 ring-white/10 outline-none focus:ring-white/25"
          >
            {TASK_AREAS.map((area) => (
              <option key={area} value={area}>
                {area.charAt(0).toUpperCase() + area.slice(1)}
              </option>
            ))}
          </select>
        </Row>

        <Row
          label="Notice when a meeting starts"
          hint="Watches which applications hold the microphone and offers to record when a meeting app takes it. It only ever offers — nothing records itself. Dictation is excluded, so your own hotkey never triggers it."
        >
          <Toggle
            label="Notice when a meeting starts"
            on={settings.meetings.autoDetect}
            onChange={(autoDetect) => save({ meetings: { ...settings.meetings, autoDetect } })}
          />
        </Row>
      </Section>
      <BotAccountSection settings={settings} save={save} />
      </div>}

      {tab === 'storage' && <div className="space-y-4">
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
        <Row
          label="Every dictation"
          hint="The transcripts, the timings and any audio still kept with them. There is no undo, and no copy anywhere else."
        >
          <DeleteEverything />
        </Row>
      </Section>
      </div>}

      {tab === 'advanced' && <div className="space-y-4">
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
      </div>}
    </div>
  )
}
