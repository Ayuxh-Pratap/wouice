import { describe, expect, it } from 'vitest'
import { needsEnglish } from './english.js'

const line = (text: string, textEn: string | null = null, echo = false) => ({ text, textEn, echo })

describe('which lines still need English', () => {
  it('does not count a line already spoken and written in English', () => {
    // From a real improved transcript: the notice said the English was being
    // written above lines like this one.
    expect(needsEnglish(line('Okay, so I am recording this for testing purposes.'))).toBe(false)
  })

  it('counts a Hindi line with no rendering yet', () => {
    expect(needsEnglish(line('प्रेमार करते हैं'))).toBe(true)
    expect(needsEnglish(line('मैं leaderboard check करूँगा'))).toBe(true)
  })

  it('does not count a line that has its English, or an echo', () => {
    expect(needsEnglish(line('प्रेमार करते हैं', 'they love it'))).toBe(false)
    expect(needsEnglish(line('प्रेमार करते हैं', null, true))).toBe(false)
  })
})
