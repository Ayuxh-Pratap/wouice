#!/usr/bin/env node
// Fill a throwaway Wouice profile with invented data, so the app can be looked
// at - and photographed - without a GPU, without models, and without putting
// anybody's real meetings on screen.
//
//   npx tsx scripts/demo-seed.ts          # writes <repo>/.demo
//   npx tsx scripts/demo-seed.ts --dir D  # somewhere else
//   npm run demo                          # seed, build, and launch against it
//
// Everything here is fictional: a team of three shipping a delivery app called
// Lumen. The meeting is a bot meeting, so the transcript carries the marks a
// real one does - Meet's own captions, lines it later dropped, English rendered
// line by line, a summary checked against the lines it came from.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStore, MEET_CAPTIONS_SOURCE, type CheckedSummary } from '@wouice/store'
import { DEFAULT_SETTINGS } from '../desktop/src/shared/settings.js'

const V1 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(V1, '../..')
const at = process.argv.indexOf('--dir')
export const DEMO_DIR = at === -1 ? path.join(REPO, '.demo') : path.resolve(process.argv[at + 1]!)

/** The cast. Nobody real: the names, the product and every line below are made up. */
const ME = 'Aarav Mehta'
const PRIYA = 'Priya Nair'
const DEVANSH = 'Devansh Rao'

const MEETING_AT = new Date('2026-10-14T18:30:00+05:30').getTime()
const minute = 60_000

interface Said {
  /** Milliseconds from the start of the call. */
  at: number
  who: string
  /** As Meet's captions wrote it. */
  text: string
  /** The same line after the English pass. */
  en: string
  /** Words Meet showed and then replaced: kept, and shown dimmed. */
  dropped?: boolean
}

const CALL: Said[] = [
  { at: 12_000, who: ME, text: 'हां तो शुरू करते हैं, pricing पहले देख लेते हैं', en: 'Yes, let us start - we will look at pricing first' },
  { at: 26_000, who: PRIYA, text: 'मैंने दोनों plans का draft बना लिया है', en: 'I have made a draft of both plans' },
  { at: 41_000, who: ME, text: 'paid plan कितने का रख रहे हैं', en: 'How much are we keeping the paid plan at?' },
  { at: 58_000, who: PRIYA, text: 'चार सौ निन्यानवे रुपए महीना, और सालाना लो तो दो महीने free', en: '499 rupees a month, and two months free if you take it yearly' },
  { at: 74_000, who: DEVANSH, text: 'ठीक है, चलो यही रखते हैं', en: 'Okay, let us keep that' },
  { at: 92_000, who: ME, text: 'free tier में कितनी deliveries', en: 'How many deliveries in the free tier?' },
  { at: 108_000, who: PRIYA, text: 'दिन की दस, उसके बाद paid', en: 'Ten a day, paid after that' },
  { at: 126_000, who: DEVANSH, text: 'दस ठीक है, pilot में औसत सात थीं', en: 'Ten is fine - the average in the pilot was seven' },
  { at: 149_000, who: ME, text: 'और जो pricing page का copy है वो अभी भी confusing लग रहा है', en: 'And the copy on the pricing page still reads as confusing' },
  { at: 167_000, who: PRIYA, text: 'हां मैं उसको दोबारा लिखती हूं, कल तक भेज दूंगी', en: 'Yes, I will rewrite it and send it by tomorrow' },
  { at: 186_000, who: DEVANSH, text: 'एक चीज और', en: 'One more thing', dropped: true },
  { at: 192_000, who: DEVANSH, text: 'courier का webhook कभी कभी fail हो रहा है, retry नहीं है उसमें', en: 'The courier webhook fails sometimes, and there is no retry on it' },
  { at: 214_000, who: ME, text: 'कितनी बार हुआ अब तक', en: 'How many times has it happened so far?' },
  { at: 228_000, who: DEVANSH, text: 'पिछले हफ्ते में चार बार, हर बार order stuck हो गया', en: 'Four times last week, and the order got stuck each time' },
  { at: 252_000, who: ME, text: 'तो retry डाल दो उसमें, तीन कोशिश और फिर alert', en: 'Then put a retry on it - three attempts and then an alert' },
  { at: 271_000, who: DEVANSH, text: 'हां वो मैं कर दूंगा इस हफ्ते', en: 'Yes, I will do that this week' },
  { at: 295_000, who: PRIYA, text: 'onboarding में भी एक', en: 'In onboarding there is also one', dropped: true },
  { at: 302_000, who: PRIYA, text: 'onboarding screen पर लोग रुक जा रहे हैं, PayKit वाला step समझ नहीं आ रहा', en: 'People are stopping on the onboarding screen - the PayKit step is not understood' },
  { at: 330_000, who: ME, text: 'उसका data है कितने लोग drop कर रहे हैं', en: 'Is there data on how many people are dropping off?' },
  { at: 345_000, who: PRIYA, text: 'तीन में से एक वहीं छोड़ देता है', en: 'One in three leaves right there' },
  { at: 368_000, who: DEVANSH, text: 'वो इसलिए क्योंकि PayKit अपना अलग page खोलता है', en: 'That is because PayKit opens its own separate page' },
  { at: 392_000, who: ME, text: 'तो उसको inline कर सकते हैं क्या', en: 'So can we make that inline?' },
  { at: 410_000, who: DEVANSH, text: 'हो सकता है, एक दिन लगेगा देखने में', en: 'It can be done - it will take a day to look into' },
  { at: 436_000, who: ME, text: 'ठीक है, तुम देख लो और कल बता देना', en: 'Okay, you look into it and tell me tomorrow' },
  { at: 462_000, who: PRIYA, text: 'launch की date क्या रख रहे हैं फिर', en: 'What date are we keeping for the launch then?' },
  { at: 478_000, who: ME, text: 'अट्ठाईस तारीख, अगर webhook वाला fix हो जाए तो', en: 'The 28th, if the webhook fix lands' },
  { at: 500_000, who: DEVANSH, text: 'हो जाएगा, उससे पहले ready है', en: 'It will - it is ready before that' },
  { at: 524_000, who: PRIYA, text: 'मैं marketing वालों को बता दूं फिर', en: 'Shall I tell the marketing people then?' },
  { at: 540_000, who: ME, text: 'हां बता दो, और screenshots भी भेज देना उनको', en: 'Yes, tell them, and send them the screenshots too' },
  { at: 566_000, who: PRIYA, text: 'ठीक है', en: 'Okay' },
  { at: 604_000, who: DEVANSH, text: 'एक छोटा सा', en: 'A small one', dropped: true },
  { at: 612_000, who: DEVANSH, text: 'refund का flow अभी manual है, वो अगले sprint में डालें', en: 'The refund flow is still manual - shall we put it in the next sprint?' },
  { at: 640_000, who: ME, text: 'हां अगले sprint में, अभी नहीं', en: 'Yes, next sprint, not now' },
  { at: 664_000, who: ME, text: 'ठीक है, कल फिर बात करते हैं', en: 'Okay, we will talk again tomorrow' },
]

/** What you typed while the call ran. */
const SCRATCH = `pricing: 499/mo, 10 free deliveries a day
webhook retries - ask Devansh for the number
launch 28th if the webhook fix lands`

function seed(): void {
  rmSync(DEMO_DIR, { recursive: true, force: true })
  mkdirSync(DEMO_DIR, { recursive: true })

  // Settings, whole rather than partial: the app merges a partial file over its
  // defaults, and a half-written one is a confusing thing to photograph.
  writeFileSync(
    path.join(DEMO_DIR, 'settings.json'),
    JSON.stringify(
      {
        ...DEFAULT_SETTINGS,
        meetings: { ...DEFAULT_SETTINGS.meetings, me: { ...DEFAULT_SETTINGS.meetings.me, name: ME } },
        // Codette, not one of the borrowed characters: these screenshots are published.
        pet: { ...DEFAULT_SETTINGS.pet, enabled: true, character: 'codette' },
      },
      null,
      2
    ) + '\n'
  )

  const store = openStore({ dir: DEMO_DIR })
  const dir = path.join(DEMO_DIR, 'meetings', `${new Date(MEETING_AT).toISOString().replace(/[:.]/g, '-')}-bot`)
  mkdirSync(dir, { recursive: true })

  const meetingId = store.meetings.start(dir, MEETING_AT, 'mixed')
  store.meetings.setTitle(meetingId, 'Lumen - pricing and the launch checklist')
  const versionId = store.meetings.appendToVersion(
    meetingId,
    MEET_CAPTIONS_SOURCE,
    CALL.map((line) => ({
      channel: line.who === ME ? ('me' as const) : ('them' as const),
      startMs: line.at,
      endMs: line.at + 4_000,
      text: line.text,
      echo: false,
      speaker: line.who,
      ...(line.dropped ? { dropped: true } : {}),
    })),
    MEETING_AT
  )
  store.meetings.setMain(meetingId, versionId)
  store.meetings.setScratch(meetingId, SCRATCH)

  // The ids the lines were given, so the summary and the tasks can point at the
  // exact line each came from - which is what the time link follows.
  const stored = store.meetings.segments(meetingId, versionId)
  const idAt = (ms: number): number => stored.find((s) => s.startMs === ms)!.id
  store.meetings.setEnglish(stored.map((s, i) => ({ id: s.id, textEn: CALL[i]!.en })))

  const summary: CheckedSummary = {
    gist: [
      { text: 'A pricing call on Lumen: the paid plan is 499 rupees a month, and the free tier keeps ten deliveries a day.', points: [0, 1] },
      { text: 'The courier webhook has no retry and stuck four orders last week, so launch is the 28th if that fix lands.', points: [2, 4] },
    ],
    points: [
      { text: 'The paid plan is 499 rupees a month, with two months free on the yearly plan', mark: 'agreed', segmentIds: [idAt(58_000), idAt(74_000)], quote: '499 rupees a month, and two months free', atMs: 58_000 },
      { text: 'The free tier keeps ten deliveries a day; the pilot averaged seven', mark: 'agreed', segmentIds: [idAt(108_000), idAt(126_000)], quote: 'Ten a day, paid after that', atMs: 108_000 },
      { text: 'The courier webhook has no retry, and stuck four orders last week', mark: null, segmentIds: [idAt(192_000), idAt(228_000)], quote: 'there is no retry on it', atMs: 192_000 },
      { text: 'One in three people leaves onboarding at the PayKit step, which opens its own page', mark: null, segmentIds: [idAt(302_000), idAt(345_000)], quote: 'One in three leaves right there', atMs: 302_000 },
      { text: 'Launch is the 28th, if the webhook fix lands before it', mark: 'agreed', segmentIds: [idAt(478_000), idAt(500_000)], quote: 'The 28th, if the webhook fix lands', atMs: 478_000 },
      { text: 'The refund flow stays manual until the next sprint', mark: 'agreed', segmentIds: [idAt(612_000), idAt(640_000)], quote: 'Yes, next sprint, not now', atMs: 612_000 },
    ],
    more: [
      { text: 'The pricing page copy is being rewritten because it reads as confusing', mark: null, segmentIds: [idAt(149_000)], quote: 'still reads as confusing', atMs: 149_000 },
      { text: 'Marketing is to be told, with screenshots', mark: null, segmentIds: [idAt(540_000)], quote: 'send them the screenshots too', atMs: 540_000 },
    ],
  }
  store.meetings.setVersionSummary(versionId, summary)
  store.meetings.setVersionNotes(
    versionId,
    [
      '## In short',
      summary.gist.map((s) => s.text).join(' '),
      '',
      '## Key points',
      ...summary.points.map((p) => `- [${stamp(p.atMs!)}] ${p.mark ? `(${p.mark}) ` : ''}${p.text}`),
      '',
      '## Next steps',
      '- Rewrite the pricing page copy (Priya Nair)',
      '- Put a retry on the courier webhook, three attempts then an alert (Devansh Rao)',
      '- Look at making the PayKit step inline (Devansh Rao)',
      '- Tell marketing the launch date, with screenshots (Priya Nair)',
    ].join('\n')
  )

  store.meetings.replaceTasks(versionId, [
    {
      text: 'Rewrite the pricing page copy',
      owner: PRIYA,
      due: null,
      segmentId: idAt(167_000),
      kind: 'content',
      area: 'product',
      status: 'agreed',
      description: 'The copy on the pricing page reads as confusing. Priya is rewriting it and sending it the next day.',
    },
    {
      text: 'Put a retry on the courier webhook: three attempts, then an alert',
      owner: DEVANSH,
      due: null,
      segmentId: idAt(252_000),
      kind: 'bug',
      area: 'backend',
      status: 'agreed',
      description: 'The courier webhook failed four times last week and each failure left an order stuck. Three attempts, then raise an alert.',
    },
    {
      text: 'Find out whether the PayKit step can be inline',
      owner: DEVANSH,
      due: null,
      segmentId: idAt(410_000),
      kind: 'research',
      area: 'frontend',
      status: 'proposed',
      description: 'PayKit opens its own page during onboarding and one in three people leave there. A day to find out whether it can be done inline.',
    },
    {
      text: 'Tell marketing the launch date and send them the screenshots',
      owner: PRIYA,
      due: null,
      segmentId: idAt(540_000),
      kind: 'followup',
      area: 'business',
      status: 'agreed',
      description: 'The launch is the 28th, subject to the webhook fix. Marketing needs the date and the screenshots.',
    },
    {
      text: 'Move the refund flow off manual in the next sprint',
      owner: null,
      due: null,
      segmentId: idAt(612_000),
      kind: 'feature',
      area: 'ops',
      status: 'proposed',
      description: 'Refunds are handled by hand today. Agreed to leave it until the next sprint rather than this one.',
    },
  ])

  store.meetings.setDiagnostics(meetingId, {
    language: 'hi-IN',
    segments: CALL.length,
    captions: { dropped: CALL.filter((l) => l.dropped).length, moved: 2, unsaved: 0 },
  })
  store.meetings.setVersionDiagnostics(versionId, {
    english: { at: MEETING_AT + 12 * minute, rendered: CALL.length, missed: 0, failedBatches: 0, ms: 38_400, model: 'gemma4-e4b' },
    vocabulary: {
      at: MEETING_AT + 12 * minute,
      sent: 4,
      entries: [
        { term: 'Lumen', said: 3, written: 3, as: [], unheard: 0, check: [] },
        { term: 'PayKit', said: 2, written: 2, as: ['पे किट'], unheard: 0, check: [] },
      ],
    },
  })
  store.meetings.recordNotesRun(versionId, {
    at: MEETING_AT + 14 * minute,
    ok: true,
    model: 'qwen35-9b',
    chunks: 1,
    gaps: 0,
    tasks: 5,
    ms: 74_000,
    coveredLines: CALL.length,
    totalLines: CALL.length,
    candidates: 7,
    filtered: 1,
    merged: 1,
    rejected: 0,
    vocabulary: ['Lumen', 'PayKit', PRIYA, DEVANSH],
    summary: { found: 9, kept: 8, badQuote: 1, offTopic: 0, shown: 6, gistKept: 2, gistWritten: 3 },
  })
  store.meetings.finish(meetingId, { endedAt: MEETING_AT + 11 * minute + 20_000, audioPath: null, durationMs: 11 * minute + 20_000 })

  for (const entry of VOCABULARY) store.vocabulary.add(entry)
  store.dictations.insertMany(dictations())
  for (const sample of samples()) store.resources.insert(sample)

  const counts = store.stats()
  store.close()
  console.log(`Demo profile written to ${DEMO_DIR}`)
  console.log(`  ${CALL.length} transcript lines, ${summary.points.length} key points, 5 tasks, ${dictations().length} dictations`)
  console.log(`  database ${(counts.bytes / 1024).toFixed(0)} KB, schema v${counts.version}`)
  console.log(`\nRun the app against it:  npm run demo`)
}

const stamp = (ms: number): string => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

const VOCABULARY = [
  { term: 'Lumen', kind: 'product' as const, aliases: [{ text: 'लुमेन', rewrite: false }], meaning: 'our delivery app', pinned: true, source: 'you' as const, state: 'active' as const },
  { term: 'PayKit', kind: 'tool' as const, aliases: [{ text: 'पे किट', rewrite: false }, { text: 'pay kit', rewrite: true }], meaning: 'the payments provider', pinned: false, source: 'you' as const, state: 'active' as const },
  { term: PRIYA, kind: 'person' as const, aliases: [], meaning: 'design', pinned: false, source: 'roster' as const, state: 'active' as const },
  { term: DEVANSH, kind: 'person' as const, aliases: [], meaning: 'backend', pinned: false, source: 'roster' as const, state: 'active' as const },
  { term: ME, kind: 'person' as const, aliases: [], meaning: '', pinned: false, source: 'roster' as const, state: 'active' as const },
  { term: 'webhook', kind: 'term' as const, aliases: [{ text: 'web hook', rewrite: true }], meaning: '', pinned: false, source: 'you' as const, state: 'active' as const },
]

/** A fortnight of dictations, so the Dashboard and the Dictations page have a history. */
function dictations() {
  const said = [
    ['कल तक pricing का draft भेज दूंगा', 'I will send the pricing draft by tomorrow', 'hindi'],
    ['Please review the latest draft and send comments by tomorrow morning.', 'Please review the latest draft and send comments by tomorrow morning.', 'english'],
    ['webhook वाला issue अभी भी open है, retry डालना पड़ेगा', 'The webhook issue is still open - we will have to add a retry', 'hindi'],
    ['The onboarding step needs to be inline, not a separate page.', 'The onboarding step needs to be inline, not a separate page.', 'english'],
    ['मीटिंग चार बजे कर लेते हैं, उससे पहले मैं free नहीं हूं', 'Let us do the meeting at four - I am not free before that', 'hindi'],
    ['Ship the pricing page first and keep the rest for next sprint.', 'Ship the pricing page first and keep the rest for next sprint.', 'english'],
    ['तीन में से एक user वहीं छोड़ देता है, data देख लो', 'One in three users leaves right there - look at the data', 'hindi'],
    ['Add a retry with three attempts and then alert me.', 'Add a retry with three attempts and then alert me.', 'english'],
    ['launch अट्ठाईस को रखा है, बता देना सबको', 'The launch is set for the 28th - tell everyone', 'hindi'],
    ['Screenshots are in the shared folder under launch.', 'Screenshots are in the shared folder under launch.', 'english'],
    ['refund का flow manual है अभी, अगले sprint में करेंगे', 'The refund flow is manual for now - we will do it next sprint', 'hindi'],
    ['Let us keep ten free deliveries a day on the free tier.', 'Let us keep ten free deliveries a day on the free tier.', 'english'],
  ]
  const now = Date.now()
  return said.map(([raw, final, language], i) => ({
    at: now - (i + 1) * 3.4 * 3_600_000,
    audioMs: 6_400 + i * 900,
    asrMs: 1_180 + (i % 5) * 120,
    llmMs: 690 + (i % 4) * 95,
    totalMs: 1_980 + (i % 6) * 140,
    chunks: i % 5 === 0 ? 2 : 0,
    asrModel: 'turbo',
    llmModel: 'qwen3-4b',
    language: language!,
    rawChars: raw!.length,
    finalChars: final!.length,
    corrections: i % 3 === 0 ? 1 : 0,
    degraded: null,
    raw: raw!,
    corrected: raw!,
    sentSystem: 'Rewrite what was said as clean English. Keep the meaning.',
    sentUser: raw!,
    received: final!,
    applied: [],
    capture: null,
    audioPath: null,
    inserted: true,
    delivery: 'paste',
    targetExe: i % 2 ? 'Code.exe' : 'chrome.exe',
    deliveryNote: '',
  }))
}

/** An hour of VRAM samples: idle, then a meeting's larger model, then idle again. */
function samples() {
  const now = Date.now()
  return Array.from({ length: 120 }, (_, i) => {
    const minutesAgo = 60 - i / 2
    const working = minutesAgo < 42 && minutesAgo > 18
    return {
      at: now - minutesAgo * minute,
      vramUsedMiB: Math.round(working ? 5_180 + Math.sin(i) * 120 : 1_240 + Math.sin(i) * 40),
      vramTotalMiB: 6_144,
      rssMiB: Math.round(working ? 780 + Math.sin(i) * 30 : 540 + Math.sin(i) * 20),
    }
  })
}

seed()
