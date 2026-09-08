// Detecting Hindi that survived a cleanup pass.
//
// The cleanup prompt says, in capitals, to render Hindi as English. Whether it
// obeyed is the single most important quality question for this app, and it has
// to be checkable automatically - a person cannot rate every run of a benchmark.
//
// Two scripts, two different problems. Devanagari is trivially detectable.
// Romanised Hinglish is Latin text that looks like English to any naive check,
// so it is found by its function words: the content words of a sentence vary
// endlessly, but "hai", "kya", "nahi" and their friends do not.

/**
 * Romanised Hindi function words.
 *
 * Deliberately excludes anything that is also an ordinary English word - "hum"
 * and "main" are both, and including them would flag clean English output as a
 * failure, which is worse than missing a case.
 */
const HINDI_MARKERS =
  /\b(abhi|kuch|sahih|kya|nahi|nahin|sakte|sakta|mein|hai|hain|karna|karne|karke|chahiye|lagta|lagti|thoda|thodi|yeh|woh|aur|lekin|baaki|theek|yaar|matlab|jaldi|padega|padegi|kyunki|isliye|bohot|bahut|acha|accha|mujhe|tumhe|humein|unko)\b/gi

const DEVANAGARI = /[ऀ-ॿ]/g

export function analyseLanguage(text) {
  const devanagari = (text.match(DEVANAGARI) ?? []).length
  const markers = [...new Set((text.match(HINDI_MARKERS) ?? []).map((m) => m.toLowerCase()))]
  return {
    devanagari,
    markers,
    /** True when nothing Hindi survived, in either script. */
    english: devanagari === 0 && markers.length === 0,
  }
}

export function looksHinglish(text) {
  return !analyseLanguage(text).english
}
