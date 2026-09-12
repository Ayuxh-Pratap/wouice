import { describe, expect, it } from 'vitest'
import { scoreAgainstPanel } from './caption-score.js'

/**
 * The bot's lines against Meet's own caption panel: which words, and whose,
 * not how they were cut into lines.
 */

describe('scoring against the panel', () => {
  it('is perfect when every word is there, with its speaker', () => {
    const panel = [{ speaker: 'Himanshu', text: 'काम की चीज है वो' }]
    expect(scoreAgainstPanel(panel, [{ speaker: 'Himanshu', text: 'काम की चीज है वो' }])).toMatchObject({
      wer: 0,
      exact: 1,
      speakerWer: 0,
      panelWords: 5,
      keptWords: 5,
    })
  })

  it('counts words changed, missing and extra against the panel', () => {
    const panel = [{ speaker: 'Rahul', text: 'we will ship it friday' }]
    const score = scoreAgainstPanel(panel, [{ speaker: 'Rahul', text: 'we will ship on friday now' }])
    expect(score.wer).toBeCloseTo(2 / 5)
    expect(score.exact).toBeCloseTo(4 / 5)
  })

  it('does not care how the words were cut into lines, or the punctuation', () => {
    const panel = [{ speaker: 'Rahul', text: 'Okay. We need SSO before the rollout.' }]
    const kept = [
      { speaker: 'Rahul', text: 'okay' },
      { speaker: 'Rahul', text: 'We need SSO' },
      { speaker: 'Rahul', text: 'before the rollout' },
    ]
    expect(scoreAgainstPanel(panel, kept).wer).toBeCloseTo(1 / 7)
    expect(scoreAgainstPanel(panel, kept.map((l, i) => (i === 0 ? { ...l, text: 'Okay' } : l))).wer).toBe(0)
  })

  it('charges a right word on the wrong speaker only to the speaker score', () => {
    const panel = [
      { speaker: 'Ayush', text: 'hello there' },
      { speaker: 'Himanshu', text: 'hi' },
    ]
    const kept = [
      { speaker: 'Ayush', text: 'hello' },
      { speaker: 'Himanshu', text: 'there hi' },
    ]
    const score = scoreAgainstPanel(panel, kept)
    expect(score.wer).toBe(0)
    expect(score.speakerWer).toBeCloseTo(1 / 3)
  })

  it('counts the turns the panel showed, not its empty blocks', () => {
    const panel = [
      { speaker: 'Ayush', text: 'ठीक है' },
      { speaker: 'Himanshu', text: ' ' },
    ]
    expect(scoreAgainstPanel(panel, []).panelTurns).toBe(1)
  })
})
