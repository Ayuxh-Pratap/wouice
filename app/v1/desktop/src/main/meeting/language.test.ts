import { describe, expect, it } from 'vitest'
import { heardIn, languageForChunk, scriptLanguage } from './language.js'

/**
 * Choosing each chunk's language for the careful pass, from what the first
 * pass wrote. The lines below are from real meetings.
 */

describe('reading the language off the first pass', () => {
  it('calls English speech English, though the meeting was set to Hindi + English', () => {
    // The large model, forced to Hindi, turned this into Hindi-script nonsense.
    expect(scriptLanguage(['okay, so I am recording this for testing purposes'], 'hi')).toBe('en')
  })

  it('calls Hindi speech Hindi', () => {
    expect(scriptLanguage(['मतलब मैं तो यही चीज सोच रहा था कि सुपने वे कितना बढ़िया है यार'], 'hi')).toBe('hi')
  })

  it('counts words, so a Hindi sentence with English nouns stays Hindi', () => {
    expect(scriptLanguage(['मैं leaderboard check करूँगा'], 'hi')).toBe('hi')
    expect(scriptLanguage(['मैं कल leaderboard check करूँगा'], 'hi')).toBe('hi')
  })

  it('falls back when the first pass heard nothing there', () => {
    expect(scriptLanguage([], 'hi')).toBe('hi')
    expect(scriptLanguage(['...', '1500'], 'hi')).toBe('hi')
  })
})

describe('the stretch it reads', () => {
  const lines = [
    { channel: 'me' as const, startMs: 0, endMs: 4_000, text: 'okay so I am recording' },
    { channel: 'them' as const, startMs: 1_000, endMs: 2_000, text: 'झाल' },
    { channel: 'me' as const, startMs: 26_000, endMs: 30_000, text: 'the placeholder text is large' },
  ]

  it('takes only that side, and only lines overlapping the chunk', () => {
    expect(heardIn(lines, 'me', 0, 25_000)).toEqual(['okay so I am recording'])
    expect(heardIn(lines, 'them', 0, 25_000)).toEqual(['झाल'])
    expect(heardIn(lines, 'me', 25_000, 50_000)).toEqual(['the placeholder text is large'])
  })
})

describe('the language for a chunk', () => {
  it('keeps an English meeting English', () => {
    expect(languageForChunk('en', ['मतलब मैं तो'])).toBe('en')
  })

  it('reads a Hindi or mixed meeting stretch by stretch', () => {
    expect(languageForChunk('hi', ['okay, so I am recording this'])).toBe('en')
    expect(languageForChunk('hi', ['मतलब मैं तो यही चीज'])).toBe('hi')
  })

  it('uses what "let it detect" pinned', () => {
    expect(languageForChunk('auto', [], 'en')).toBe('en')
    expect(languageForChunk('auto', ['okay, so I am recording'], 'hi')).toBe('en')
    expect(languageForChunk('auto', [], null)).toBe('auto')
  })
})
