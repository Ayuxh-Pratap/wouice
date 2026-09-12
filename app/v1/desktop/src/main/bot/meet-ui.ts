/**
 * Everything the bot knows about Google Meet's page, in one file.
 *
 * WHY ONE FILE. Meet changes its page every few weeks: Attendee, the most
 * complete open-source bot, needed two or three fixes a month in 2026 for new
 * button wording, new dialogs and new end-of-call messages. When joining
 * breaks, this is the file to open - and the screenshot the run saved shows
 * what the page said instead.
 *
 * WORDS OVER STRUCTURE. Meet's class names are machine-generated and change
 * without notice; the words on its buttons and in its messages change far less
 * often. So the page is read by what it says, in English: the bot's account is
 * set to English, and every link it opens carries `hl=en`.
 *
 * The lists come from Attendee's Google Meet adapter (Elastic License 2.0), as
 * facts about Meet's page; the code reading them is our own.
 */

/** The join button, in every wording Meet has used. Longest first, so the most specific wins. */
export const JOIN_LABELS = [
  'Ask to join anyway',
  'Join the call now',
  'Join here too',
  'Join anyway',
  'Ask to join',
  'Join now',
] as const

export const TEXTS = {
  notFound: [
    'Check your meeting code',
    'Invalid video call name',
    'Your meeting code has expired',
    "The meeting code you entered doesn't work",
  ],
  /** Meet refusing the account outright - since 2026, often a bot it treats as a risk. */
  blocked: ["You can't join this video call", 'There is a problem connecting to this video call'],
  denied: [
    'Someone in the call denied your request to join',
    'No one responded to your request to join the call',
  ],
  /** The page after leaving. Before joining it means the request went nowhere. */
  selfLeft: ['You left the meeting'],
  asking: [
    'Asking to be let in',
    'Please wait until a meeting host brings you into the call',
    "You'll join the call when someone lets you in",
  ],
  waitingForHost: ['Waiting for the host to join'],
  removed: ["You've been removed from the meeting", 'Someone has removed you from the meeting'],
  ended: ['The call ended because everyone left', 'Your host ended the meeting for everyone'],
  /** Google's sign-in page, reached when the profile is not signed in after all. */
  login: ['Use your Google Account'],
  continueWithoutDevices: 'Continue without microphone and camera',
} as const

/** What one look at the page found. Collected inside the page by `snapshotScript`. */
export interface PageSnapshot {
  text: string
  /** The guest name box - only shown to someone who is not signed in. */
  nameInput: boolean
  /** Which join button is on screen, if any. */
  joinButton: string | null
  /** The red leave button: only there once the bot is in the call. */
  leaveButton: boolean
  continueWithoutDevices: boolean
  micOn: boolean
  cameraOn: boolean
  /** A notice with an OK button - "this call is being recorded" and the like. */
  dialogOk: boolean
  /** Distinct participant tiles, the bot's own included. 0 when they cannot be read. */
  participants: number
  url: string
}

export type PageVerdict =
  | { kind: 'in-meeting' }
  | { kind: 'removed' }
  | { kind: 'ended' }
  | { kind: 'self-left' }
  | { kind: 'failed'; reason: 'not-found' | 'blocked' | 'denied' | 'login-required' }
  | { kind: 'continue-without-devices' }
  | { kind: 'waiting-for-host' }
  | { kind: 'asking' }
  | { kind: 'ready'; join: string }
  | { kind: 'loading' }

/** Curly apostrophes as straight ones: Meet uses both, in the same sentence on different days. */
function normalise(text: string): string {
  return text.replace(/[‘’]/g, "'")
}

/**
 * What the page means.
 *
 * THE LEAVE BUTTON FIRST. Once the bot is in the call, the page is full of
 * other people's words - chat, names, and in stage B2 captions. Someone typing
 * "the call ended because everyone left" into the chat must not end the bot's
 * meeting, and while the leave button is on screen, the bot is in the call
 * whatever the text says. Every other message is only read when it is not.
 */
export function readPage(snapshot: PageSnapshot): PageVerdict {
  if (snapshot.leaveButton) return { kind: 'in-meeting' }

  const text = normalise(snapshot.text)
  const says = (phrases: readonly string[]): boolean => phrases.some((p) => text.includes(normalise(p)))

  if (says(TEXTS.removed)) return { kind: 'removed' }
  if (says(TEXTS.ended)) return { kind: 'ended' }
  if (says(TEXTS.denied)) return { kind: 'failed', reason: 'denied' }
  if (says(TEXTS.selfLeft)) return { kind: 'self-left' }
  if (says(TEXTS.blocked)) return { kind: 'failed', reason: 'blocked' }
  if (says(TEXTS.notFound)) return { kind: 'failed', reason: 'not-found' }
  // A signed-in account never sees the name box. Seeing it means the profile
  // is not signed in, and the bot never joins as an anonymous guest (D1).
  if (snapshot.nameInput || says(TEXTS.login)) return { kind: 'failed', reason: 'login-required' }
  if (snapshot.continueWithoutDevices) return { kind: 'continue-without-devices' }
  if (says(TEXTS.waitingForHost)) return { kind: 'waiting-for-host' }
  if (says(TEXTS.asking)) return { kind: 'asking' }
  if (snapshot.joinButton) return { kind: 'ready', join: snapshot.joinButton }
  return { kind: 'loading' }
}

/**
 * A Meet link, in the one form the bot opens.
 *
 * Accepts what people actually paste: a full link, one without https, one with
 * `?authuser=1` on the end, or the bare code. Anything else is not a Meet link,
 * and saying so beats the bot opening it and failing a minute later.
 */
export function meetUrl(input: string): string | null {
  const trimmed = input.trim()
  const code =
    /^(?:https?:\/\/)?meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#].*)?$/i.exec(trimmed)?.[1] ??
    /^([a-z]{3}-[a-z]{4}-[a-z]{3})$/i.exec(trimmed)?.[1]
  return code ? `https://meet.google.com/${code.toLowerCase()}?hl=en` : null
}

/**
 * The one script run inside Meet's page, as source text.
 *
 * A STRING, NOT A FUNCTION. A function handed to the page is serialised with
 * `toString`, and a bundler that has touched it - adding a helper for kept
 * names, say - produces source that refers to things the page does not have.
 * Text is exactly what runs.
 */
export function snapshotScript(joinLabels: readonly string[] = JOIN_LABELS): string {
  return `(() => {
  const labels = ${JSON.stringify(joinLabels)};
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const q = (selector) => document.querySelector(selector);
  const buttons = Array.from(document.querySelectorAll('button'));
  const labelOf = (button) => {
    const own = norm(button.textContent);
    const spans = Array.from(button.querySelectorAll('span')).map((s) => norm(s.textContent));
    return labels.find((l) => own === l || spans.includes(l)) || null;
  };
  let joinButton = null;
  for (const button of buttons) {
    const label = labelOf(button);
    if (label) { joinButton = label; break; }
  }
  const ids = new Set(
    Array.from(document.querySelectorAll('[data-participant-id]')).map((e) => e.getAttribute('data-participant-id'))
  );
  return {
    text: document.body ? document.body.innerText.slice(0, 20000) : '',
    nameInput: !!q('input[aria-label="Your name"]'),
    joinButton,
    leaveButton: !!q('[aria-label^="Leave call"]'),
    continueWithoutDevices: buttons.some((b) => norm(b.textContent) === ${JSON.stringify(TEXTS.continueWithoutDevices)}),
    micOn: !!q('[aria-label^="Turn off microphone"]'),
    cameraOn: !!q('[aria-label^="Turn off camera"]'),
    dialogOk: !!q('button[data-mdc-dialog-action="ok"]'),
    participants: ids.size,
    url: location.href,
  };
})()`
}

/** One block of Meet's own caption panel: a speaker, and what Meet finally made of their words. */
export interface PanelTurn {
  speaker: string
  text: string
}

/**
 * Meet's caption panel as it stands: one block per speaker turn, at Meet's
 * final revisions - the text a person in the call could read, and what the
 * bot's own lines are scored against.
 *
 * By structure, not class names, which Meet obfuscates and changes: the panel
 * is the region labelled "Captions", and a turn is a child of it holding a
 * picture, then a name, and last the words.
 */
export const CAPTION_PANEL_SCRIPT = `(() => {
  const region = document.querySelector('[role="region"][aria-label="Captions"]');
  if (!region) return null;
  const turns = [];
  for (const block of Array.from(region.children)) {
    const name = block.querySelector('span');
    const words = block.lastElementChild;
    if (!block.querySelector('img') || !name || !words || words.contains(name)) continue;
    turns.push({ speaker: (name.textContent || '').trim(), text: (words.textContent || '').trim() });
  }
  return turns;
})()`
