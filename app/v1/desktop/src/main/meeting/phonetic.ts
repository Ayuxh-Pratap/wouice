/**
 * Matching a name by how it sounds, across Devanagari and Latin script.
 *
 * WHY. Meet's captions write English words in Devanagari by their sound -
 * "Claude" comes out as "क्लॉड", or misheard as "लॉर्ड" - and the English that
 * is rendered from them writes "Lord". A vocabulary that only matched exact
 * spellings needed every form typed twice, once in each script, before it could
 * even be offered to the model. This lets one entry, in either script, be found
 * in the other. See docs/design/09-vocabulary.md (V3).
 *
 * HOW. Devanagari is transliterated to Latin letters, then both are reduced to
 * a sound key: vowels dropped, and the spellings that sound alike folded
 * together (ph/f, soft c/s, q/k, w/v, z/j, the aspirates onto their plain
 * consonants). "Lord" and "लॉर्ड" are both "lrd"; "Claude" and "क्लॉड" both
 * "kld"; "Qwen" and "क्वेन" both "kvn".
 *
 * A key is coarse on purpose, so it is only trusted when it is long enough to
 * say something: a form whose key is shorter than three sounds ("coin" is "kn")
 * matches only as spelled. And it only ever decides which entries are OFFERED
 * to the model as reference - never what gets written.
 */

const CONSONANTS: Record<string, string> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'ळ': 'l', 'व': 'v',
  'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
}

/** A consonant with a nukta below it: the sounds Hindi borrowed. */
const NUKTA_FORMS: Record<string, string> = {
  'क': 'q', 'ख': 'kh', 'ग': 'g', 'ज': 'z', 'ड': 'r', 'ढ': 'rh', 'फ': 'f', 'य': 'y',
}
const PRECOMPOSED: Record<string, string> = {
  'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f', 'य़': 'y',
}

const VOWELS: Record<string, string> = {
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri',
  'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e',
}
const SIGNS: Record<string, string> = {
  'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri',
  'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e',
}
const HALANT = '्'
const NUKTA = '़'

const DEVANAGARI = /[ऀ-ॿ]/

/** One word of Devanagari in Latin letters, the way it sounds: "लॉर्ड" -> "lord". */
export function transliterate(word: string): string {
  const chars = [...word]
  let out = ''
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!
    let consonant = PRECOMPOSED[c]
    if (consonant === undefined && CONSONANTS[c] !== undefined) {
      if (chars[i + 1] === NUKTA) {
        consonant = NUKTA_FORMS[c] ?? CONSONANTS[c]
        i++
      } else {
        consonant = CONSONANTS[c]
      }
    }
    if (consonant !== undefined) {
      out += consonant
      const next = chars[i + 1]
      if (next !== undefined && SIGNS[next] !== undefined) {
        out += SIGNS[next]
        i++
      } else if (next === HALANT) {
        i++
      } else if (next !== undefined && DEVANAGARI.test(next)) {
        // The inherent vowel - dropped at the end of a word, as Hindi speaks it.
        out += 'a'
      }
      continue
    }
    if (VOWELS[c] !== undefined) out += VOWELS[c]
    else if (SIGNS[c] !== undefined) out += SIGNS[c]
    // A nasal takes the place of the consonant after it: "बंप" is "bamp", "संग" is "sang".
    else if (c === 'ं' || c === 'ँ') out += /[पफबभम]/.test(chars[i + 1] ?? '') ? 'm' : 'n'
    else if (c === 'ः') out += 'h'
    else if (c >= '०' && c <= '९') out += String(c.charCodeAt(0) - '०'.charCodeAt(0))
    else if (!DEVANAGARI.test(c)) out += c
  }
  return out
}

/**
 * A number is one sound however it is written: "1", "one" and "वन" (as Meet's
 * captions write it) all key as "#1", so "Phase 1" is found where the captions
 * have "फेस वन" and the English "face one". The English number words and the
 * way the captions spell them only - not Hindi's own numbers, where "दो" is also
 * "give". A number on its own is too short a key to match by sound anyway.
 */
const NUMBERS: Record<string, string> = {
  zero: '0', jeero: '0', zeero: '0',
  one: '1', van: '1',
  two: '2', too: '2',
  three: '3', thri: '3',
  four: '4', phor: '4',
  five: '5', phaaiv: '5', phaiv: '5',
  six: '6', siks: '6',
  seven: '7', sevan: '7',
  eight: '8', et: '8',
  nine: '9', naain: '9', nain: '9',
  ten: '10',
}

/** A word in plain Latin letters, lower case: Devanagari transliterated, marks and punctuation gone. */
function latin(word: string): string {
  return (DEVANAGARI.test(word) ? transliterate(word) : word).toLowerCase().replace(/[^a-z0-9]/g, '')
}

function numberOf(s: string): string | undefined {
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : NUMBERS[s]
}

/** A word's sound key: "Claude", "क्लॉड" -> "kld"; "Phase", "फेस" -> "fs"; "1", "one", "वन" -> "#1". */
export function soundKey(word: string): string {
  const s = latin(word)
  const number = numberOf(s)
  if (number !== undefined) return `#${number}`
  // Vowels carry little across scripts and recognisers; the consonants carry
  // the word. All but a leading one, kept as a single mark: without it
  // "iframe" was "from" and "राउंड" was "अराउंड" (around) in meeting 18. One
  // mark for any vowel, since "iframe" and "आईफ्रेम" start with different ones.
  // A letter written twice is one sound, so doubles go first - after the
  // vowels, "Bible" lost its second b and became "bl", too short to trust
  // (meeting 20).
  const f = folded(s).replace(/(.)\1+/g, '$1')
  return (/^[aeiou]/.test(f) ? '*' : '') + f.replace(/[aeiouy]/g, '')
}

/**
 * A word's close key: the same folding with its vowels kept, long ones made
 * short. Too strict to find "Claude" in "क्लॉड" - the sound key does that - but
 * exact enough to trust on a short word, where the sound key is not: "coin" and
 * "कॉइन" are both "koin", where "can" is "kan" and "keen" is "kin".
 */
export function closeKey(word: string): string {
  const s = latin(word)
  const number = numberOf(s)
  if (number !== undefined) return `#${number}`
  return folded(s)
    .replace(/aa/g, 'a')
    .replace(/ee|ii|y/g, 'i')
    .replace(/oo|uu/g, 'u')
    .replace(/(.)\1+/g, '$1')
}

/** The spellings that sound alike, folded together. */
function folded(s: string): string {
  return s
    .replace(/chh|ch/g, 'c')
    .replace(/ph/g, 'f')
    .replace(/sh/g, 's')
    .replace(/([kgbdtj])h/g, '$1')
    .replace(/ck/g, 'k')
    .replace(/qu/g, 'kv')
    .replace(/wh/g, 'v')
    // A soft c sounds like s; every other c, like k. The Devanagari "ch" has
    // already become c above and is kept apart from both as "c" -> "c".
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/w/g, 'v')
    .replace(/z/g, 'j')
}

/** Words as the matcher sees them: letters, the marks that go with them, and digits. */
export function wordsOf(text: string): string[] {
  return text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
}

/** A piece of text, prepared once for many forms to be looked for in it. */
export interface Prepared {
  words: string[]
  lower: string[]
  keys: string[]
  close: string[]
  /** Which words are Devanagari: a sound key only bridges the two scripts. */
  devanagari: boolean[]
}

export function prepare(text: string): Prepared {
  const words = wordsOf(text)
  return {
    words,
    lower: words.map((w) => w.toLowerCase()),
    keys: words.map(soundKey),
    close: words.map(closeKey),
    devanagari: words.map((w) => DEVANAGARI.test(w)),
  }
}

/** Shorter than this, a sound key matches too many words to mean anything. */
const MIN_KEY = 3
/** And a close key, shorter than this. */
const MIN_CLOSE = 4

/**
 * Is this form - a term or a sound-alike, one or more words - in the text?
 * As spelled; or by its close key; or, between the two scripts and when its
 * key is long enough to trust, by sound.
 *
 * THE SOUND KEY ONLY BRIDGES SCRIPTS. It drops vowels so that "Lord" can find
 * "लॉर्ड"; between two words in the same script that is only a loss, and in
 * meeting 18 it had JSON's "जसन" in "जिसने" (who) and route's "राउंड" in
 * "अराउंड" (around). Within a script a word is matched as spelled, or by its
 * close key, which keeps the vowels.
 */
export function soundsIn(form: string, text: Prepared): boolean {
  const words = wordsOf(form)
  if (words.length === 0 || words.length > text.words.length) return false
  const lower = words.map((w) => w.toLowerCase())
  const keys = words.map(soundKey)
  const close = words.map(closeKey)
  const devanagari = words.map((w) => DEVANAGARI.test(w))
  // The leading-vowel mark says where a word starts, not how much of it there
  // is: counted, it made OpenAI's "*pn" long enough to find "ओपन" (open).
  const bySound = keys.join('').replaceAll('*', '').length >= MIN_KEY && keys.every((k) => k.length > 0)
  const byClose = close.join('').length >= MIN_CLOSE
  for (let at = 0; at + words.length <= text.words.length; at++) {
    let spelled = true
    let sounded = bySound
    let near = byClose
    for (let j = 0; j < words.length; j++) {
      if (text.lower[at + j] !== lower[j]) spelled = false
      if (text.keys[at + j] !== keys[j] || text.devanagari[at + j] === devanagari[j]) sounded = false
      if (text.close[at + j] !== close[j]) near = false
      if (!spelled && !sounded && !near) break
    }
    if (spelled || sounded || near) return true
  }
  return false
}
