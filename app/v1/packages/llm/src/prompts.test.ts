import { describe, expect, it } from 'vitest'
import { isPlausibleCleanup, containsDevanagari } from './prompts.js'

/**
 * These cases come from real output observed during the Hinglish spike. The
 * first version of the guard rejected 4 of 18 legitimate dictations because it
 * matched first-person pronouns, so the "must ACCEPT" block is the important
 * half of this file.
 */
describe('isPlausibleCleanup accepts real speech', () => {
  const input = 'a'.repeat(120)

  const legitimate = [
    // Every one of these was rejected by the first implementation.
    "I'll just say that the side bar length can be a bit shorter.",
    "I'll also change the page color so it feels more premium.",
    'I can see your account here, let us get this sorted out.',
    'Okay, so we need to ship the auth fix before Friday.',
    'Sure we can do that on Monday.',
    "Here's the thing, the sidebar is too wide.",
    'Of course we should refactor that layout.',
    'Fix this on the backend, not on the frontend.',
  ]

  for (const text of legitimate) {
    it(`accepts: "${text.slice(0, 46)}..."`, () => {
      expect(isPlausibleCleanup(input, text).ok).toBe(true)
    })
  }
})

describe('isPlausibleCleanup rejects assistant replies', () => {
  const input = 'a'.repeat(120)

  const replies = [
    'Sure, here is the cleaned text you asked for.',
    "Certainly! Here's the corrected version.",
    'Here is the cleaned transcript:',
    'Corrected text: the sidebar is too wide.',
    'I have cleaned up the transcript and removed the fillers.',
    'As an AI, I cannot process that request.',
    "I'm sorry, but I cannot help with that.",
  ]

  for (const text of replies) {
    it(`rejects: "${text.slice(0, 46)}..."`, () => {
      expect(isPlausibleCleanup(input, text).ok).toBe(false)
    })
  }
})

describe('isPlausibleCleanup structural checks', () => {
  it('rejects output that elaborated well beyond the input', () => {
    expect(isPlausibleCleanup('short', 'x'.repeat(200)).ok).toBe(false)
  })

  it('rejects output that summarised the input away', () => {
    expect(isPlausibleCleanup('a'.repeat(500), 'ok').ok).toBe(false)
  })

  it('allows Hindi to compress substantially when rendered in English', () => {
    // Devanagari is verbose in characters; English of the same meaning is much
    // shorter, so a tight lower bound would reject every Hinglish dictation.
    const hindi = 'आपको बैक एंड से एपीआई के अंदर डेटा ही सही नहीं मिल रहा है। तो आपने इसको बैक एंड से फिक्स करो।'
    const english = 'Fix this on the backend, not on the frontend.'
    expect(isPlausibleCleanup(hindi, english).ok).toBe(true)
  })

  it('rejects Devanagari that the model introduced itself', () => {
    expect(isPlausibleCleanup('plain english in', 'कुछ हिंदी').ok).toBe(false)
  })

  it('allows Devanagari to pass through when the input had it', () => {
    // Not our preferred outcome, but it is a cleanup failure, not a fabrication.
    expect(isPlausibleCleanup('मुझे यह चाहिए', 'मुझे यह चाहिए').ok).toBe(true)
  })

  it('treats empty output as legitimate: the caller decides what to do', () => {
    expect(isPlausibleCleanup('unintelligible noise', '').ok).toBe(true)
  })
})

describe('containsDevanagari', () => {
  it('detects Hindi script', () => {
    expect(containsDevanagari('मुझे ये feature chahiye')).toBe(true)
  })
  it('is false for pure latin', () => {
    expect(containsDevanagari('mujhe ye feature chahiye')).toBe(false)
  })
})
