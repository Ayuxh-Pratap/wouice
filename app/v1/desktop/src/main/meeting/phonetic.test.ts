import { describe, expect, it } from 'vitest'
import { closeKey, prepare, soundKey, soundsIn, transliterate } from './phonetic.js'

describe('Devanagari in Latin letters', () => {
  it('writes a word the way it sounds', () => {
    expect(transliterate('लॉर्ड')).toBe('lord')
    expect(transliterate('क्वेन')).toBe('kven')
    expect(transliterate('कॉइन')).toBe('koin')
    expect(transliterate('हिमांशु')).toBe('himaanshu')
    expect(transliterate('ज़ूम')).toBe('zoom')
    expect(transliterate('फ़ेस')).toBe('fes')
  })

  it('sounds a nasal as the consonant after it, with the vowel before it', () => {
    expect(transliterate('बंप')).toBe('bamp')
    expect(transliterate('संग')).toBe('sang')
    expect(soundKey('बंप')).toBe(soundKey('Bump'))
  })
})

describe('sound keys', () => {
  it('give an English word and its Devanagari spelling the same key', () => {
    const pairs: [string, string][] = [
      ['Lord', 'लॉर्ड'],
      ['Claude', 'क्लॉड'],
      ['Qwen', 'क्वेन'],
      ['Phase', 'फेस'],
      ['Bump', 'बम्प'],
      ['Himanshu', 'हिमांशु'],
      ['Solana', 'सोलाना'],
      ['WebSocket', 'वेबसॉकेट'],
      ['iframe', 'आईफ्रेम'],
      ['Google', 'गूगल'],
    ]
    for (const [latin, devanagari] of pairs) expect(soundKey(devanagari), `${latin} / ${devanagari}`).toBe(soundKey(latin))
  })

  it('keeps a leading vowel, so a word is not found in one that only lacks it', () => {
    // Meeting 18: "रिटर्न फ्रॉम रिस्पांस" counted as iframe, "अराउंड नेवीगेशन" as route.
    expect(soundKey('iframe')).toBe(soundKey('आईफ्रेम'))
    expect(soundKey('iframe')).not.toBe(soundKey('फ्रॉम'))
    expect(soundKey('राउंड')).not.toBe(soundKey('अराउंड'))
    expect(soundsIn('iframe', prepare('रिटर्न फ्रॉम रिस्पांस'))).toBe(false)
    expect(soundsIn('राउंड', prepare('98 अराउंड नेवीगेशन'))).toBe(false)
    expect(soundKey('Atlas')).toBe(soundKey('एटलस'))
    // The mark does not make a short key long enough to trust: OpenAI is not "ओपन" (open).
    expect(soundsIn('OpenAI', prepare('ओपन मी प्राइस'))).toBe(false)
  })

  it('matches by sound only across scripts; within one, by spelling or the close key', () => {
    // Meeting 18: JSON's "जसन" and "जिसने" (who) share their consonants, and nothing else.
    expect(soundsIn('जसन', prepare('जिसने लगता है कोई फर्क नहीं पड़ा'))).toBe(false)
    expect(soundsIn('जशन', prepare('भेज सकता है मुझे जसन'))).toBe(true)
    // Across scripts the sound key still does its work.
    expect(soundsIn('Lord', prepare('गिव तू मी लॉर्ड'))).toBe(true)
    // And an English variant is found by its close key.
    expect(soundsIn('Qwen', prepare('this quen model'))).toBe(true)
  })

  it('keeps words that sound different apart', () => {
    expect(soundKey('Claude')).not.toBe(soundKey('Lord'))
    expect(soundKey('Bump')).not.toBe(soundKey('Bible'))
    expect(soundKey('Qwen')).not.toBe(soundKey('coin'))
  })
})

describe('finding a form in text', () => {
  it('finds a Latin sound-alike in Hindi captions, and a name written in Devanagari', () => {
    expect(soundsIn('Lord', prepare('हैव कैप्शंस तू गिव तू मी लॉर्ड'))).toBe(true)
    expect(soundsIn('Qwen', prepare('अपना ये क्वेन थ्री मॉडल'))).toBe(true)
    expect(soundsIn('Himanshu', prepare('हिमांशु ने बोला'))).toBe(true)
  })

  it('matches every word of a longer form, in order', () => {
    expect(soundsIn('Phase 1', prepare('according to our Phase 1 plan'))).toBe(true)
    expect(soundsIn('फेस वन', prepare('अभी जो हमारा फेस वन है'))).toBe(true)
    expect(soundsIn('Google Meet', prepare('गूगल मीट के अंदर'))).toBe(true)
    expect(soundsIn('Google Meet', prepare('Google Drive and a meet'))).toBe(false)
  })

  it('finds a short word across scripts by its close key, and nothing that merely shares its consonants', () => {
    expect(closeKey('coin')).toBe('koin')
    expect(closeKey('कॉइन')).toBe('koin')
    expect(soundsIn('coin', prepare('ये कॉइन थ्री फूड बिलियन'))).toBe(true)
    expect(soundsIn('coin', prepare('we can do it, keen'))).toBe(false)
    expect(soundsIn('coin', prepare('कैन और किन'))).toBe(false)
  })

  it('hears a number the same however it is written', () => {
    expect(new Set(['1', 'one', 'वन', 'One'].map(soundKey))).toEqual(new Set(['#1']))
    expect(soundKey('थ्री')).toBe(soundKey('3'))
    expect(soundsIn('Phase 1', prepare('अभी जो हमारा फेस वन है'))).toBe(true)
    expect(soundsIn('Phase 1', prepare('according to our face one'))).toBe(true)
    expect(soundsIn('Phase 1', prepare('the face of it, one by one'))).toBe(false)
    // On its own, a number is too short a key to match by sound.
    expect(soundsIn('one', prepare('वन'))).toBe(false)
  })

  it('only trusts a short key as spelled', () => {
    // "coin" is "kn" - it would sound like "can", "keen" and "kin".
    expect(soundsIn('coin', prepare('we can do it'))).toBe(false)
    expect(soundsIn('coin', prepare('a meme coin'))).toBe(true)
    expect(soundsIn('कॉइन', prepare('ये कॉइन थ्री'))).toBe(true)
  })
})
