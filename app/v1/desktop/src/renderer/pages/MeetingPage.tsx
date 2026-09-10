import { useCallback, useEffect, useRef, useState } from 'react'
import type { MeetingRecord, TaskArea, TaskRecord, TaskState, VersionRecord } from '@wouice/store'
import type {
  EnglishProgressView,
  MeetingJobView,
  MeetingSegment,
  MeetingState,
  NotesProgressView,
  RepassProgressView,
} from '../../shared/ipc.js'
import { kindOf } from '../../shared/meeting-kind.js'
import { needsEnglish } from '../meetings/english.js'
import { describeJob, jobColour, useMeetingJobs } from '../meetings/jobs.js'
import { isImproved, mainVersion, versionLabel } from '../meetings/versions.js'
import { Notes } from '../meetings/Notes.js'
import { Transcript } from '../meetings/Transcript.js'
import { Icon } from '../shell/Icon.js'
import { Tabs } from '../shell/Tabs.js'

/**
 * One meeting, on its own page.
 *
 * TWO STATES, ONE ADDRESS. While it records, this is the recording: a clock, a
 * transcript arriving, and somewhere to jot. Afterwards it is the record: the
 * summary, the tasks, the transcript. Same page, because they are the same
 * meeting and being sent somewhere else at the moment you press stop is exactly
 * when you least want to be.
 *
 * THE PIPELINE IS NOT A SET OF BUTTONS. Stopping a meeting produces the
 * transcript, then the English rendering, then the summary and tasks, without
 * anybody pressing anything. Doing one of them again is editing, so those
 * controls are small and out of the way.
 */

const RECORDING_PHASES = new Set(['starting', 'recording', 'stopping', 'merging'])

/**
 * Three things, read at different times.
 *
 * You open a meeting to check what you agreed, or to work the task list, or to
 * read what was actually said - very rarely two of those in one visit. Stacked
 * down a page, every visit costs a scroll past the parts you did not come for.
 */
type MeetingTab = 'summary' | 'tasks' | 'transcript'

export function MeetingPage({ meetingId }: { meetingId: number }): React.JSX.Element {
  const [meeting, setMeeting] = useState<MeetingRecord | null>(null)
  const [segments, setSegments] = useState<MeetingSegment[]>([])
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [state, setState] = useState<MeetingState | null>(null)
  const [english, setEnglish] = useState(true)
  const [notesProgress, setNotesProgress] = useState<NotesProgressView | null>(null)
  const [englishProgress, setEnglishProgress] = useState<EnglishProgressView | null>(null)
  const [repass, setRepass] = useState<RepassProgressView | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [problem, setProblem] = useState('')
  const [copied, setCopied] = useState(false)
  const [tab, setTab] = useState<MeetingTab | null>(null)
  const [taskFilter, setTaskFilter] = useState<'all' | 'mine' | 'area'>('all')
  const [myArea, setMyArea] = useState<TaskArea>('frontend')
  /** Which version is on screen. Null follows the main one, including when it changes. */
  const [viewing, setViewing] = useState<number | null>(null)
  /** Something else is running: asked before this one queues behind it. */
  const [queueing, setQueueing] = useState<{ what: string; start(): void } | null>(null)
  const jobs = useMeetingJobs()

  // Your area names the third filter. Read once; it changes in Settings.
  useEffect(() => {
    void window.wouice.getSettings().then((s) => setMyArea(s.meetings.me.area))
  }, [])

  const load = useCallback(() => {
    void window.wouice.getMeeting(meetingId).then(setMeeting)
    void window.wouice.getMeetingSegments(meetingId, viewing ?? undefined).then(setSegments)
    void window.wouice.getMeetingTasks(meetingId, viewing ?? undefined).then(setTasks)
  }, [meetingId, viewing])

  // Again whenever work on this meeting starts or stops, and the progress of a
  // job that has finished is forgotten with it.
  const busyHere = jobs.running?.meetingId === meetingId
  useEffect(() => {
    if (!busyHere) {
      setNotesProgress(null)
      setEnglishProgress(null)
      setRepass(null)
    }
    load()
  }, [load, busyHere])

  useEffect(() => {
    void window.wouice.getMeetingState().then(setState)
    const offState = window.wouice.onMeetingState(setState)
    // Segments arrive during the meeting; re-reading is a single indexed query
    // and is always right, where appending to a local list drifts on a reload.
    const offSegments = window.wouice.onMeetingSegments(() => {
      void window.wouice.getMeetingSegments(meetingId).then(setSegments)
    })
    // The latest step wins: the English pass and the summary run one after the
    // other, and the first one's last message must not outlive it.
    const offNotes = window.wouice.onNotesProgress((p) => {
      if (p.meetingId !== meetingId) return
      setNotesProgress(p)
      setEnglishProgress(null)
    })
    const offEnglish = window.wouice.onEnglishProgress((p) => {
      if (p.meetingId !== meetingId) return
      setEnglishProgress(p)
      setNotesProgress(null)
    })
    const offRepass = window.wouice.onRepassProgress((p) => {
      if (p.meetingId === meetingId) setRepass(p)
    })
    // A step finished partway through a job - the English, before the summary.
    // Re-read, so what is on screen is what is stored.
    const offUpdated = window.wouice.onMeetingUpdated((id) => {
      if (id === meetingId) load()
    })
    const offDone = window.wouice.onMeetingProcessed((id) => {
      if (id !== meetingId) return
      setNotesProgress(null)
      setEnglishProgress(null)
      setRepass(null)
      load()
    })
    return () => {
      offState()
      offSegments()
      offNotes()
      offEnglish()
      offRepass()
      offDone()
      offUpdated()
    }
  }, [meetingId, load])

  if (!meeting) {
    return <p className="py-10 text-center text-[13px] text-neutral-500">Loading…</p>
  }

  const live = state?.meetingId === meetingId && RECORDING_PHASES.has(state.phase)
  const kind = kindOf(meeting.kind)
  // Lines that still need an English rendering. A line already spoken in
  // English is its own English and is not counted.
  const missingEnglish = segments.filter(needsEnglish).length
  // What is on screen: the version picked, or the main one. Everything below
  // reads from this one version, so a summary is only ever shown with the
  // transcript it was written from.
  const main = mainVersion(meeting)
  const version = meeting.versions.find((v) => v.id === viewing) ?? main
  const onMain = version === null || version.main
  const notesMd = version?.notesMd ?? null
  const shownLines = version?.segments ?? meeting.segments
  // A step that failed on this version, said where its result would have been.
  const lastRun = (version?.diagnostics.notes ?? []).at(-1)
  const summaryFailed = lastRun && !lastRun.ok ? (lastRun.message ?? 'it failed') : null
  const englishFailed =
    version?.diagnostics.english?.ok === false
      ? (version.diagnostics.english.message ?? 'it failed')
      : null
  // The version that is not main, when there are two: what the menu can switch to.
  const other = meeting.versions.length > 1 ? (meeting.versions.find((v) => !v.main) ?? null) : null
  // Tasks are written with the summary. A version with no summary yet has none
  // of its own to show, whatever an earlier run of it left behind.
  const listed = notesMd !== null ? tasks : []
  // Asked of the job queue, not inferred from progress messages - which only
  // arrive while something is reporting, so a page opened mid-run looked idle.
  const running = jobs.running?.meetingId === meetingId ? jobs.running : null
  const waiting = running ? null : (jobs.queued.find((j) => j.meetingId === meetingId) ?? null)
  const working = running !== null || waiting !== null
  // Whether the English itself is being written right now - not merely whether
  // anything is running. The summary step of the same job is not it.
  const englishPending =
    englishProgress !== null ||
    running?.kind === 'english' ||
    repass?.stage === 'warming' ||
    repass?.stage === 'rendering' ||
    (running?.kind === 'process' && notesProgress === null)
  const improved = isImproved(meeting)
  // Whatever there is to read. Landing on an empty Summary when the transcript
  // is right there is a click for nothing.
  const shown: MeetingTab = tab ?? (notesMd ? 'summary' : 'transcript')

  const changeTask = (taskId: number, taskState: TaskState): void => {
    setTasks((current) => current.map((t) => (t.id === taskId ? { ...t, state: taskState } : t)))
    void window.wouice.setTaskState(taskId, taskState)
  }

  /**
   * Start a job, or ask first when another is already running.
   *
   * One runs at a time - there is one card - so starting this behind another
   * means waiting, and behind a careful pass that can be twenty minutes. Worth
   * a question rather than a surprise.
   */
  const startJob = (what: string, run: () => Promise<{ ok: boolean; message: string }>): void => {
    const go = (): void => {
      setProblem('')
      void run().then((outcome) => {
        if (!outcome.ok) setProblem(outcome.message)
        load()
      })
    }
    if (jobs.running) setQueueing({ what, start: go })
    else go()
  }

  const redo = (what: 'notes' | 'english'): void =>
    startJob(what === 'notes' ? 'Redo summary' : 'Redo English', () =>
      what === 'notes'
        ? window.wouice.generateNotes(meetingId)
        : window.wouice.renderEnglish(meetingId)
    )

  /**
   * The English if this transcript has none, then the summary and tasks.
   *
   * What the summary's own button does. The summary is written from the
   * English, so writing it alone while the English is missing would build it
   * from raw recognition output.
   */
  const finish = (): void =>
    startJob('Write the English, summary and tasks', () => window.wouice.processMeeting(meetingId))

  /** Work from another version: for when the careful pass came out worse. */
  const makeMain = async (versionId: number): Promise<void> => {
    setProblem('')
    const refused = await window.wouice.setMainVersion(meetingId, versionId)
    if (refused) setProblem(refused)
    setViewing(null)
    load()
  }

  /* ------------------------------------------------------------ recording -- */

  if (live) {
    const settling = state!.phase !== 'recording'
    return (
      <div className="flex h-full flex-col gap-3">
        <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex items-center gap-2.5">
            <span className="size-2 shrink-0 animate-pulse rounded-full bg-red-500" />
            <span className="text-[24px] font-semibold tabular-nums text-neutral-50">
              {formatElapsed(state?.elapsedMs ?? 0)}
            </span>
          </span>

          {/*
            Who is being heard, next to the control that ends it. Two faces
            rather than two dots: a ring that lights as somebody speaks reads at
            a glance and says WHOSE audio is arriving, which is the one thing
            that is invisible until you play the file back an hour later.
          */}
          <span className="ml-auto flex items-center gap-1.5">
            {(state?.channels ?? []).map((c) => (
              <SpeakingAvatar key={c.channel} view={c} />
            ))}
            <button
              onClick={() => void window.wouice.stopMeeting()}
              disabled={state?.phase === 'merging'}
              className="ml-1 rounded-lg bg-red-500/15 px-4 py-1.5 text-[12.5px] font-medium text-red-300 ring-1 ring-red-500/30 transition hover:bg-red-500/25 disabled:opacity-40"
            >
              Stop
            </button>
          </span>
        </header>

        {/* Status belongs under the row it describes, not wedged inside it. */}
        {settling || state?.message ? (
          <p className="shrink-0 text-[11.5px] text-neutral-500">
            {state?.message || describePhase(state!.phase)}
          </p>
        ) : null}

        {/*
          NOTES ABOVE THE TRANSCRIPT. The transcript grows without bound over an
          hour; the notes box does not. Putting the fixed thing on top means it
          stays where you left it, and the part that grows takes whatever is
          left rather than pushing anything around.
        */}
        <LiveNotes meetingId={meetingId} initial={meeting.scratchMd} />

        <section className="lift flex min-h-0 flex-1 flex-col rounded-xl bg-white/[0.035] px-4 py-3 ring-1 ring-white/[0.08]">
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <Transcript
              segments={segments}
              emptyMessage="Lines appear about half a minute behind the conversation."
            />
          </div>
        </section>
      </div>
    )
  }

  /* ------------------------------------------------------------- finished -- */

  const aura = running ? jobColour(running.kind) : null

  return (
    <div className="relative space-y-4">
      {/*
        Something is happening, said with light rather than with a spinner. It
        sits behind the content it belongs to, so a glance at the page answers
        "is it still working" without reading anything. Green while it writes,
        orange while it re-transcribes - the slow one that costs you dictation
        should not look like the quick one.
      */}
      {aura ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-6 h-48 animate-pulse rounded-[3rem] blur-3xl"
          style={{ background: `radial-gradient(55% 100% at 50% 0%, ${aura}66 0%, transparent 72%)` }}
        />
      ) : null}

      <header className="relative flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <a
            href="#/meetings"
            className="text-[11.5px] text-neutral-500 transition hover:text-neutral-300"
          >
            ← All meetings
          </a>
          <h1 className="mt-1 truncate text-[19px] font-semibold tracking-tight text-neutral-50">
            {meeting.title ?? formatWhen(meeting.startedAt)}
          </h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-neutral-500">
            {/* No "improved" badge here: the switch beside the title already
                says which version this is, and saying it twice was noise. */}
            <span>
              {formatDuration(meeting.durationMs)} · {shownLines} line
              {shownLines === 1 ? '' : 's'} · {kind.label}
              {meeting.endedAt === null ? ' · never finished' : ''}
            </span>
          </div>
        </div>

        {/*
          Which transcript you are reading, level with the title: the one
          choice on this page that changes everything under it. Improving is
          offered in the same place, as the version it would create. Your
          notes, redoing a step and the audio are in the menu.
        */}
        <div className="flex shrink-0 items-center gap-1.5 self-center">
          <VersionSwitch
            versions={meeting.versions}
            shown={version?.id ?? null}
            onShow={setViewing}
            improving={running?.kind === 'improve' ? describeImproving(repass) : null}
            waiting={waiting?.kind === 'improve'}
            canImprove={!working && meeting.audioPath !== null}
            onImprove={() => setConfirming(true)}
          />
          <Menu
            items={[
              {
                label: meeting.scratchMd ? 'Your notes •' : 'Your notes',
                onClick: () => setNotesOpen(true),
              },
              ...(meeting.versions.length > 1
                ? [
                    {
                      // Offered for when a better model arrives; the dialog says
                      // the same model gives essentially the same transcript.
                      label: 'Improve accuracy again',
                      onClick: () => setConfirming(true),
                      disabled: working || !meeting.audioPath,
                    },
                  ]
                : []),
              ...(other
                ? [
                    {
                      // For when the careful pass came out worse than the first.
                      label:
                        versionLabel(other.source) === 'First pass'
                          ? 'Go back to the first pass'
                          : 'Use the improved version',
                      onClick: () => void makeMain(other.id),
                      disabled: working,
                    },
                  ]
                : []),
              ...(kind.translate
                ? [
                    {
                      label: 'Redo English',
                      onClick: () => void redo('english'),
                      disabled: working || segments.length === 0,
                    },
                  ]
                : []),
              {
                label: 'Redo summary',
                onClick: () => void redo('notes'),
                disabled: working || segments.length === 0,
              },
              { label: 'Show audio file', onClick: () => window.wouice.revealMeeting(meeting.dir) },
              {
                label: copied ? 'Copied' : 'Copy diagnostic',
                onClick: () => {
                  void window.wouice.copyMeetingDiagnostic(meetingId)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                },
              },
            ]}
          />
        </div>
      </header>

      {running ? (
        <div className="relative flex items-center gap-2.5 rounded-xl bg-white/[0.05] px-4 py-2.5 ring-1 ring-white/[0.10]">
          <span
            className="size-1.5 shrink-0 animate-pulse rounded-full"
            style={{ backgroundColor: jobColour(running.kind) }}
          />
          <span className="text-[12.5px] text-neutral-200">
            {/* The step, once one has reported; until then, what the job is. */}
            {repass
              ? describeRepass(repass)
              : englishProgress
                ? 'Rendering into English…'
                : notesProgress
                  ? describeNotes(notesProgress)
                  : `${describeJob(running.kind)}…`}
          </span>
        </div>
      ) : waiting ? (
        <div className="relative flex items-center gap-2.5 rounded-xl bg-white/[0.03] px-4 py-2.5 ring-1 ring-white/[0.08]">
          <span className="size-1.5 shrink-0 rounded-full bg-neutral-500" />
          <span className="text-[12.5px] text-neutral-400">
            Waiting — {describeJob(waiting.kind).toLowerCase()} starts when the job running now
            finishes.
          </span>
        </div>
      ) : null}

      {problem ? (
        <p className="relative rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
          {problem}
        </p>
      ) : null}

      <div className="relative space-y-3">
        {version && !version.main && main ? (
          <p className="text-[11.5px] text-neutral-500">
            Looking at the {versionLabel(version.source).toLowerCase()}. Its tasks are read-only —
            the {versionLabel(main.source).toLowerCase()} version is the one you work from.
          </p>
        ) : null}
        <Tabs<MeetingTab>
          tabs={[
            { id: 'summary', label: 'Summary' },
            { id: 'tasks', label: 'Tasks', badge: listed.filter((t) => t.state === 'open').length },
            { id: 'transcript', label: 'Transcript', badge: segments.length },
          ]}
          active={shown}
          onChange={setTab}
        />

        {shown === 'summary' && version ? <Coverage version={version} /> : null}

        {shown === 'summary' ? (
          notesMd ? (
            <Notes markdown={notesMd} tasks={[]} onTaskState={changeTask} />
          ) : (
            <Empty
              text={
                working
                  ? 'The summary is being written.'
                  : segments.length === 0
                    ? 'Nothing was transcribed, so there is nothing to summarise.'
                    : summaryFailed
                      ? `The summary could not be written: ${summaryFailed}.`
                      : improved && onMain
                        ? 'No summary has been written from the improved transcript yet.'
                        : 'No summary yet.'
              }
              action={
                !working && onMain && segments.length > 0
                  ? {
                      label: summaryFailed ? 'Try again' : 'Write summary and tasks',
                      onClick: finish,
                    }
                  : undefined
              }
            />
          )
        ) : null}

        {shown === 'tasks' && listed.length > 0 ? (
          <TaskFilters
            active={taskFilter}
            onChange={setTaskFilter}
            area={myArea}
            counts={{
              all: listed.length,
              mine: listed.filter((t) => t.mine).length,
              area: listed.filter((t) => t.area === myArea).length,
            }}
          />
        ) : null}

        {shown === 'tasks' ? (
          listed.length > 0 ? (
            filterTasks(listed, taskFilter, myArea).length > 0 ? (
              <Notes
                markdown={null}
                tasks={filterTasks(listed, taskFilter, myArea)}
                onTaskState={changeTask}
                readOnly={!onMain}
              />
            ) : (
              <Empty
                text={
                  taskFilter === 'mine'
                    ? 'Nothing here is yours. Set your name in Settings → Meetings if something should be.'
                    : `Nothing tagged ${myArea} in this meeting.`
                }
              />
            )
          ) : (
            <Empty
              text={
                working
                  ? 'Looking for tasks.'
                  : notesMd === null && segments.length > 0
                    ? summaryFailed
                      ? `The summary and tasks could not be written: ${summaryFailed}.`
                      : 'Tasks are written with the summary, and this transcript has no summary yet.'
                    : 'No tasks. Most conversations contain none, and inventing them would be worse.'
              }
            />
          )
        ) : null}

        {shown === 'transcript' ? (
          <section className="lift flex max-h-[62vh] flex-col rounded-xl bg-white/[0.035] px-4 py-3.5 ring-1 ring-white/[0.08]">
            {/* On every version of a meeting that has English at all - not only
                when this one's English happens to exist. Its absence is said
                below, rather than shown as a missing button. */}
            {kind.translate ? (
              <div className="mb-2.5 flex shrink-0 justify-end gap-1">
                {[
                  { on: true, label: 'English' },
                  { on: false, label: 'As spoken' },
                ].map((choice) => (
                  <button
                    key={choice.label}
                    onClick={() => setEnglish(choice.on)}
                    aria-pressed={english === choice.on}
                    className={
                      'rounded-md px-2 py-0.5 text-[11px] ring-1 transition ' +
                      (english === choice.on
                        ? 'bg-white/[0.09] text-neutral-200 ring-white/20'
                        : 'text-neutral-500 ring-white/10 hover:bg-white/5')
                    }
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            ) : null}
            {kind.translate && english && missingEnglish > 0 ? (
              <EnglishMissing
                missing={missingEnglish}
                running={englishPending}
                failed={englishFailed}
                onRedo={onMain && !working ? () => void redo('english') : undefined}
              />
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <Transcript
                segments={segments}
                english={english && kind.translate}
                emptyMessage="No transcript — it was recorded before transcription existed, or the speech model was not running."
              />
            </div>
          </section>
        ) : null}
      </div>

      {confirming ? (
        <ImproveDialog
          meeting={meeting}
          busy={jobs.running !== null}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            setProblem('')
            void window.wouice.repassMeeting(meetingId).then((outcome) => {
              if (!outcome.ok) setProblem(outcome.message)
              load()
            })
          }}
        />
      ) : null}

      {queueing ? (
        <QueueDialog
          what={queueing.what}
          running={jobs.running}
          meetingId={meetingId}
          onCancel={() => setQueueing(null)}
          onQueue={() => {
            queueing.start()
            setQueueing(null)
          }}
        />
      ) : null}

      {notesOpen ? (
        <NotesDialog
          meetingId={meetingId}
          initial={meeting.scratchMd}
          onClose={() => {
            setNotesOpen(false)
            load()
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * The overflow menu.
 *
 * What goes in here is everything that is not a decision: looking at the audio,
 * copying a diagnostic, redoing something that already ran. Six buttons in a row
 * is a row nobody reads and the first thing to break on a narrow window.
 */
function Menu({
  items,
}: {
  items: { label: string; onClick(): void; disabled?: boolean }[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    // Any click anywhere else, and Escape. A menu that needs its own button
    // pressed again to close is a menu that gets left open.
    window.addEventListener('click', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', close)
    }
  }, [open])

  return (
    <div className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen((was) => !was)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        className="rounded-lg px-2.5 py-1.5 text-[13px] leading-none text-neutral-400 ring-1 ring-white/10 transition hover:bg-white/[0.08] hover:text-neutral-200"
      >
        ⋯
      </button>
      {open ? (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          // Two steps lighter than the panel it floats over, with a real
          // shadow. At the same value as its background it read as part of the
          // page rather than as something on top of it.
          className="absolute right-0 z-40 mt-1.5 w-52 overflow-hidden rounded-lg bg-neutral-800 py-1 shadow-2xl shadow-black/60 ring-1 ring-white/[0.16]"
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                item.onClick()
              }}
              className="block w-full px-3 py-1.5 text-left text-[12px] text-neutral-300 transition hover:bg-white/[0.07] hover:text-neutral-100 disabled:opacity-40"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * What the careful pass costs, said before it starts.
 *
 * It stops the language model to make room for the larger speech model, so
 * dictation does not work while it runs, and on an hour of audio it is twenty
 * minutes. Finding that out by having a dictation silently fail would be the
 * worst possible way to learn it.
 */
function ImproveDialog({
  meeting,
  busy,
  onCancel,
  onConfirm,
}: {
  meeting: MeetingRecord
  /** Another job is running, so this one would wait its turn. */
  busy: boolean
  onCancel(): void
  onConfirm(): void
}): React.JSX.Element {
  // Measured at roughly 2.7x turbo, over both channels.
  const minutes = Math.max(1, Math.round((meeting.durationMs / 1000 / 60) * 0.75))
  const already = isImproved(meeting) ? mainVersion(meeting) : null

  return (
    <Dialog title="Transcribe this meeting again?" onClose={onCancel}>
      {/* The careful pass does not read your notes, and on the same model and
          the same audio it lands on essentially the same transcript - so a
          second run mostly buys twenty minutes without dictation. */}
      {already ? (
        <p className="mb-3 rounded-lg bg-sky-500/10 px-3 py-2 text-[12.5px] leading-snug text-sky-200 ring-1 ring-sky-400/20">
          This meeting was already improved on {formatWhen(already.createdAt)}. The same model
          will give essentially the same transcript. To use notes you have added since, Redo
          English or Redo summary instead — neither transcribes again.
        </p>
      ) : null}
      {busy ? (
        <p className="mb-3 rounded-lg bg-white/[0.05] px-3 py-2 text-[12.5px] leading-snug text-neutral-300 ring-1 ring-white/10">
          Something else is running. This will wait its turn and start when that finishes.
        </p>
      ) : null}
      <p className="text-[13px] leading-relaxed text-neutral-300">
        This runs the larger speech model over the saved audio. On a Hindi meeting it recovers
        sentences the fast model loses entirely — measured against Google&apos;s own captions, it
        is close. On the far side of a call it helps less, because that audio arrives already
        damaged by the network.
      </p>
      <ul className="mt-3 space-y-1.5 text-[12.5px] text-neutral-400">
        <li>· Roughly {minutes} minute{minutes === 1 ? '' : 's'} for this meeting.</li>
        <li>· Dictation will not work while it runs — the language model is unloaded to make room.</li>
        <li>
          · It becomes a new, improved version with its own English, summary and tasks. The first
          pass is kept, and you can switch back to look at it.
        </li>
        <li>· Tasks you have ticked or dropped carry over to the improved version.</li>
      </ul>
      <p className="mt-3 text-[12px] text-neutral-500">
        You will get a notification when it finishes. If anything fails, the transcript you have
        now is left exactly as it is.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-[12.5px] text-neutral-400 ring-1 ring-white/10 transition hover:bg-white/5"
        >
          Not now
        </button>
        <button
          onClick={onConfirm}
          className="rounded-lg bg-white/[0.09] px-3 py-1.5 text-[12.5px] font-medium text-neutral-100 ring-1 ring-white/20 transition hover:bg-white/[0.15]"
        >
          {busy ? 'Queue it' : 'Transcribe again'}
        </button>
      </div>
    </Dialog>
  )
}

/** Notes you type during or after the call, out of the way until wanted. */
function NotesDialog({
  meetingId,
  initial,
  onClose,
}: {
  meetingId: number
  initial: string
  onClose(): void
}): React.JSX.Element {
  const [text, setText] = useState(initial)
  const latest = useRef(initial)
  latest.current = text

  // Saved as you type as well as on close: a meeting that ends unexpectedly
  // should not take the last sentence with it.
  useEffect(() => {
    const timer = setTimeout(() => {
      void window.wouice.setMeetingScratch(meetingId, latest.current)
    }, 600)
    return () => clearTimeout(timer)
  }, [text, meetingId])

  const close = (): void => {
    void window.wouice.setMeetingScratch(meetingId, latest.current)
    onClose()
  }

  return (
    <Dialog title="Your notes" onClose={close}>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'pricing?? john wants Q3\nthey need SSO before rollout'}
        className="min-h-[220px] w-full resize-y rounded-md bg-black/25 px-3 py-2 text-[13px] leading-relaxed text-neutral-200 ring-1 ring-white/[0.06] outline-none placeholder:text-neutral-700 focus:ring-white/20"
      />
      <p className="mt-2 text-[11.5px] text-neutral-600">
        Rough is fine. Folded into the summary — this is what says which parts mattered to you.
      </p>
      <div className="mt-3 flex justify-end">
        <button
          onClick={close}
          className="rounded-lg bg-white/[0.09] px-3 py-1.5 text-[12.5px] font-medium text-neutral-100 ring-1 ring-white/20 transition hover:bg-white/[0.15]"
        >
          Done
        </button>
      </div>
    </Dialog>
  )
}

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string
  onClose(): void
  children: React.ReactNode
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="lift w-full max-w-lg rounded-xl bg-neutral-900 px-5 py-4 ring-1 ring-white/[0.12]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <h2 className="mb-3 text-[14px] font-medium text-neutral-100">{title}</h2>
        {children}
      </div>
    </div>
  )
}

/** How far through the whole transcription: your side first, then theirs. */
function repassPercent(p: RepassProgressView): number {
  if (p.totalSec <= 0) return 0
  const before = p.side === 'them' ? p.totalSec : 0
  return Math.min(100, Math.round(((before + p.doneSec) / (2 * p.totalSec)) * 100))
}

/** The short form, for the Improve half of the version switch. */
function describeImproving(p: RepassProgressView | null): string {
  if (!p || p.stage === 'loading') return 'Improving…'
  if (p.stage === 'transcribing') return `Improving ${repassPercent(p)}%`
  return 'Improving · writing'
}

function describeRepass(p: RepassProgressView): string {
  switch (p.stage) {
    case 'loading':
      return 'Loading the larger model…'
    case 'transcribing':
      // In meeting time, one side at a time. Adding the two sides together
      // once called a two-minute meeting "4 min".
      return p.totalSec > 0
        ? `Transcribing ${p.side === 'them' ? 'their side' : 'your side'} — ${formatClock(p.doneSec)} of ${formatClock(p.totalSec)} · ${repassPercent(p)}%`
        : 'Transcribing…'
    case 'restoring':
      return 'Putting the models back…'
    case 'warming':
      return 'Waiting for the language model to load…'
    case 'rendering':
      return 'Rendering into English…'
    default:
      return 'Writing the summary…'
  }
}

function describeNotes(progress: NotesProgressView): string {
  const where = progress.chunks > 0 ? ` ${progress.chunk} of ${progress.chunks}` : ''
  switch (progress.stage) {
    case 'condensing':
      return `Reading part${where}…`
    case 'extracting':
      return `Finding the work in part${where}…`
    case 'checking':
      return progress.chunks > 0 ? `Writing up task${where}…` : 'Grouping what was found…'
    default:
      return 'Writing the summary…'
  }
}

function describePhase(phase: string): string {
  switch (phase) {
    case 'starting':
      return 'opening the microphone and system audio'
    case 'stopping':
      return 'closing the streams'
    case 'merging':
      return 'saving the audio and finishing the transcript'
    default:
      return 'recording'
  }
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
  return `${String(minutes).padStart(2, '0')}:${seconds}`
}

/** Seconds as m:ss, for progress through a meeting. */
function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function formatWhen(epochMs: number): string {
  if (!epochMs) return 'Unknown time'
  return new Date(epochMs).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function Empty({
  text,
  action,
}: {
  text: string
  action?: { label: string; onClick(): void }
}): React.JSX.Element {
  return (
    <div className="lift rounded-xl bg-white/[0.035] px-4 py-8 text-center ring-1 ring-white/[0.08]">
      <p className="text-[12.5px] text-neutral-400">{text}</p>
      {action ? (
        <button
          onClick={action.onClick}
          className="mt-3 rounded-lg bg-white/[0.06] px-3 py-1.5 text-[12px] font-medium text-neutral-200 ring-1 ring-white/10 transition hover:bg-white/[0.12]"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  )
}

/**
 * One channel, as a small avatar whose ring lights when that person speaks.
 *
 * A GLYPH, NOT A LETTER. These were "Y" and "T", which are initials of words
 * that are never on screen: nothing tells you that T is Them rather than a
 * name, and the pair reads as two tags rather than as two sources of sound. A
 * microphone and a speaker say which input each one is without being read - your
 * voice off your own microphone, everyone else off the system's output - which
 * is also the distinction that matters when one of them is not being heard.
 *
 * Colour still does the second half of the teaching: green is you and blue is
 * them, the same two the transcript uses, so the mapping is learned once.
 *
 * The level is the same meter the dictation overlay uses, so "lit" means the
 * same thing here as it does there.
 */
function SpeakingAvatar({
  view,
}: {
  view: { channel: string; live: boolean; level: number; problem: string | null }
}): React.JSX.Element {
  const mine = view.channel === 'me'
  const speaking = view.live && view.level > 0.08
  const colour = view.problem ? '#f87171' : mine ? '#34d399' : '#60a5fa'

  return (
    <span
      className="grid size-[26px] shrink-0 place-items-center rounded-full transition-all duration-150"
      title={
        view.problem
          ? `${mine ? 'You' : 'Them'}: ${view.problem}`
          : `${mine ? 'You' : 'Them'} — ${view.live ? 'being heard' : 'not open yet'}`
      }
      style={{
        // The ring carries the state and the fill stays quiet, so two of these
        // sitting next to a red Stop button do not compete with it.
        backgroundColor: speaking ? `${colour}1f` : 'rgba(255,255,255,0.04)',
        color: speaking ? colour : view.live ? '#a3a3a3' : '#6b6b6b',
        boxShadow: speaking
          ? `0 0 0 1.5px ${colour}, 0 0 10px ${colour}66`
          : `0 0 0 1.5px ${view.live ? `${colour}4d` : 'rgba(255,255,255,0.10)'}`,
      }}
    >
      <Icon name={mine ? 'mic' : 'speaker'} className="size-[13px]" />
    </span>
  )
}

/**
 * The scratch pad, inline, for the length of the call.
 *
 * Fixed height on purpose: it is the thing that does NOT grow, so it can sit
 * above the transcript without moving as lines arrive.
 */
function LiveNotes({
  meetingId,
  initial,
}: {
  meetingId: number
  initial: string
}): React.JSX.Element {
  const [text, setText] = useState(initial)
  const latest = useRef(initial)
  latest.current = text

  // Saved as you type. A meeting that ends unexpectedly should not take the
  // last sentence with it.
  useEffect(() => {
    const timer = setTimeout(() => {
      void window.wouice.setMeetingScratch(meetingId, latest.current)
    }, 600)
    return () => clearTimeout(timer)
  }, [text, meetingId])

  useEffect(() => {
    return () => {
      void window.wouice.setMeetingScratch(meetingId, latest.current)
    }
  }, [meetingId])

  return (
    <section className="lift shrink-0 rounded-xl bg-white/[0.035] px-3.5 py-2.5 ring-1 ring-white/[0.08]">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 className="text-[11.5px] font-medium text-neutral-400">Your notes</h2>
        {/* The explanation, out of the way. It was under the box, where it read
            as more important than the box. */}
        <p className="ml-auto text-[10.5px] text-neutral-600">
          Rough is fine — used for the summary, and to spell names right.
        </p>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'pricing?? john wants Q3 · they need SSO before rollout'}
        className="h-[72px] w-full resize-none rounded-md bg-black/25 px-3 py-2 text-[12.5px] leading-relaxed text-neutral-200 ring-1 ring-white/[0.06] outline-none placeholder:text-[11px] placeholder:text-neutral-700 focus:ring-white/20"
      />
    </section>
  )
}

type TaskFilter = 'all' | 'mine' | 'area'

function filterTasks(tasks: TaskRecord[], filter: TaskFilter, area: TaskArea): TaskRecord[] {
  if (filter === 'mine') return tasks.filter((t) => t.mine)
  if (filter === 'area') return tasks.filter((t) => t.area === area)
  return tasks
}

/**
 * All, yours, or your area.
 *
 * A long meeting produces tasks for everyone in it. What you open it for is
 * usually the handful that are yours, or the ones in the part of the work you
 * own - and a list you have to read end to end to find those is a list you
 * stop opening.
 */
function TaskFilters({
  active,
  onChange,
  area,
  counts,
}: {
  active: TaskFilter
  onChange(filter: TaskFilter): void
  area: TaskArea
  counts: Record<TaskFilter, number>
}): React.JSX.Element {
  const options: { id: TaskFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'mine', label: 'Yours' },
    { id: 'area', label: area.charAt(0).toUpperCase() + area.slice(1) },
  ]
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={option.id}
          onClick={() => onChange(option.id)}
          aria-pressed={active === option.id}
          className={
            'rounded-full px-2.5 py-0.5 text-[11.5px] ring-1 transition ' +
            (active === option.id
              ? 'bg-white/[0.10] text-neutral-100 ring-white/25'
              : 'text-neutral-500 ring-white/10 hover:bg-white/[0.05] hover:text-neutral-300')
          }
        >
          {option.label}
          <span className="ml-1.5 tabular-nums text-neutral-500">{counts[option.id]}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * Said out loud when the summary did not read the whole meeting.
 *
 * WHY THIS IS A BANNER AND NOT A NUMBER IN A DIAGNOSTIC. A real hour-long
 * meeting was summarised from its last six minutes, and the summary read
 * perfectly well - it was built mostly from the notes typed during the call.
 * The only sign was "3 gap(s)" in a panel nobody opens. A partial summary that
 * looks whole is the worst possible outcome, because you would act on it.
 */
function Coverage({ version }: { version: VersionRecord }): React.JSX.Element | null {
  const run = (version.diagnostics.notes ?? []).at(-1)
  if (!run?.ok || !run.totalLines || !run.gapsAt?.length) return null
  const pct = Math.round(((run.coveredLines ?? 0) / run.totalLines) * 100)
  const where = run.gapsAt
    .map((g) => `${Math.round(g.fromMs / 60_000)}–${Math.round(g.toMs / 60_000)} min`)
    .join(', ')
  return (
    <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] leading-snug text-amber-200 ring-1 ring-amber-500/20">
      This summary covers {pct}% of the meeting. {where} could not be read, so anything
      said then is missing from the summary and the tasks. Redo summary to try again.
    </div>
  )
}


/**
 * Which transcript the page shows, and the way to make a better one.
 *
 * FIRST PASS AND IMPROVED, IN ONE PLACE. The transcript, the summary and the
 * tasks switch together, because each version owns all three. Before the
 * careful pass has run, its half of the switch is the button that runs it;
 * while it runs, that half says how far it has got, in orange.
 */
function VersionSwitch({
  versions,
  shown,
  onShow,
  improving,
  waiting,
  canImprove,
  onImprove,
}: {
  versions: VersionRecord[]
  shown: number | null
  onShow(versionId: number | null): void
  /** What the careful pass is doing, while it runs for this meeting. */
  improving: string | null
  waiting: boolean
  canImprove: boolean
  onImprove(): void
}): React.JSX.Element {
  const segment = 'rounded-md px-2.5 py-1 text-[11.5px] transition'
  return (
    <div className="inline-flex items-center rounded-lg bg-black/25 p-0.5 ring-1 ring-white/[0.08]">
      {versions.map((v) => {
        const active = v.id === shown
        const isImprovedOne = versionLabel(v.source) === 'Improved'
        return (
          <button
            key={v.id}
            // The main one is followed rather than pinned, so a newer main
            // version takes over the page when it arrives.
            onClick={() => onShow(v.main ? null : v.id)}
            aria-pressed={active}
            title={v.main ? 'The version you work from' : 'Read-only: compare against it'}
            className={
              `${segment} ` +
              (active
                ? isImprovedOne
                  ? 'bg-sky-500/15 text-sky-200 ring-1 ring-sky-400/30'
                  : 'bg-white/[0.10] text-neutral-100 ring-1 ring-white/20'
                : 'text-neutral-500 hover:text-neutral-300')
            }
          >
            {isImprovedOne ? '✦ ' : ''}
            {versionLabel(v.source)}
          </button>
        )
      })}
      {improving !== null ? (
        <span className={`${segment} flex items-center gap-1.5 text-orange-300`}>
          <span className="size-1.5 animate-pulse rounded-full bg-orange-400" />
          {improving}
        </span>
      ) : waiting ? (
        <span className={`${segment} text-neutral-500`}>Improve · waiting</span>
      ) : versions.length === 1 ? (
        <button
          onClick={onImprove}
          disabled={!canImprove}
          title="Transcribe again with the more accurate model"
          className={`${segment} text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-200 disabled:opacity-40`}
        >
          ✦ Improve
        </button>
      ) : null}
    </div>
  )
}

/**
 * English is on and some Hindi lines have no English: say why, and offer the
 * fix, rather than quietly showing them as spoken under an "English" label.
 * Lines already spoken in English are not counted - they are their English.
 */
function EnglishMissing({
  missing,
  running,
  failed,
  onRedo,
}: {
  missing: number
  running: boolean
  failed: string | null
  onRedo?: () => void
}): React.JSX.Element {
  const lines = `${missing} line${missing === 1 ? '' : 's'}`
  return (
    <div className="mb-2.5 flex shrink-0 items-center gap-3 rounded-lg bg-white/[0.04] px-3 py-2 text-[12px] leading-snug text-neutral-300 ring-1 ring-white/[0.08]">
      <span className="min-w-0 flex-1">
        {running
          ? 'The English is being written. Hindi lines are shown as spoken until then.'
          : failed
            ? `The English could not be written: ${failed}. ${lines} in Hindi are shown as spoken.`
            : `${lines} in Hindi ${missing === 1 ? 'has' : 'have'} no English yet and ${missing === 1 ? 'is' : 'are'} shown as spoken.`}
      </span>
      {!running && onRedo ? (
        <button
          onClick={onRedo}
          className="shrink-0 rounded-md bg-white/[0.08] px-2 py-0.5 text-[11.5px] text-neutral-100 ring-1 ring-white/15 transition hover:bg-white/[0.14]"
        >
          Redo English
        </button>
      ) : null}
    </div>
  )
}

/**
 * Asked when something else is already running.
 *
 * One job at a time - there is one card - so starting this means waiting, and
 * behind a careful pass that can be twenty minutes. Better asked than found out.
 */
function QueueDialog({
  what,
  running,
  meetingId,
  onCancel,
  onQueue,
}: {
  what: string
  running: MeetingJobView | null
  meetingId: number
  onCancel(): void
  onQueue(): void
}): React.JSX.Element {
  return (
    <Dialog title="Something is already running" onClose={onCancel}>
      <p className="text-[13px] leading-relaxed text-neutral-300">
        {running
          ? `Wouice is ${describeJob(running.kind).toLowerCase()} for ${
              running.meetingId === meetingId ? 'this' : 'another'
            } meeting. Only one of these runs at a time, so “${what}” would wait until it finishes.`
          : 'That has just finished, so this can start straight away.'}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-[12.5px] text-neutral-400 ring-1 ring-white/10 transition hover:bg-white/5"
        >
          Don’t start
        </button>
        <button
          onClick={onQueue}
          className="rounded-lg bg-white/[0.09] px-3 py-1.5 text-[12.5px] font-medium text-neutral-100 ring-1 ring-white/20 transition hover:bg-white/[0.15]"
        >
          {running ? 'Queue it' : 'Start'}
        </button>
      </div>
    </Dialog>
  )
}
