import { describe, expect, it } from 'vitest'
import { dropRepeatedLines, glossaryOf, glossaryReference, glossaryTerms, reduceInput } from './notes.js'

/**
 * The glossary setting and the repeat guard - the two pieces of the notes that
 * are plain text handling, so they are tested without a model.
 */
describe('the glossary', () => {
  it('reads one term per line or comma-separated, each once', () => {
    expect(glossaryTerms('Claude, Finch Bot\nBible;  claude \n\n Wouice')).toEqual(['Claude', 'Finch Bot', 'Bible', 'Wouice'])
    expect(glossaryTerms('')).toEqual([])
    expect(glossaryTerms(undefined)).toEqual([])
  })

  it('is capped, so a pasted document cannot crowd out the transcript', () => {
    const many = Array.from({ length: 200 }, (_, i) => `term${i}`).join(', ')
    expect(glossaryTerms(many)).toHaveLength(60)
  })

  it('goes in front of a request labelled as reference, one entry a line, and not at all when empty', () => {
    expect(glossaryReference(['Claude (heard as: Lord, लॉर्ड)', 'Finch Bot'])).toMatch(
      /^Glossary - [^\n]*reference only[^\n]*:\n- Claude \(heard as: Lord, लॉर्ड\)\n- Finch Bot\n\n$/
    )
    expect(glossaryReference([])).toBe('')
    expect(reduceInput('- a point', '', new Date('2026-09-12'), ['Claude'])).toMatch(/^Glossary - [^\n]*\n- Claude\n\nMeeting date: 2026-09-12/)
    expect(reduceInput('- a point', '', new Date('2026-09-12'))).toMatch(/^Meeting date: 2026-09-12/)
  })

  it('takes a fixed list, or asks for what a stretch of text calls for', () => {
    expect(glossaryOf(['Claude'], 'anything')).toEqual(['Claude'])
    expect(glossaryOf((text) => (text.includes('Lord') ? ['Claude (heard as: Lord)'] : []), 'give it to Lord')).toEqual(['Claude (heard as: Lord)'])
    expect(glossaryOf(undefined, 'anything')).toEqual([])
  })
})

describe('the repeat guard', () => {
  it('keeps each line once, however a loop wrote it', () => {
    const looped = [
      '## Next steps',
      '- Check the profile page.',
      '- Check the profile page.',
      '-  check the profile page.',
      '- Fix the banner.',
      '- Check the profile page.',
      '- The',
    ].join('\n')
    expect(dropRepeatedLines(looped)).toEqual({
      text: ['## Next steps', '- Check the profile page.', '- Fix the banner.'].join('\n'),
      dropped: 3,
    })
  })

  it('leaves notes without a loop exactly as they were, short last lines included', () => {
    const fine = '## Summary\nA test call.\n\n## Next steps\n- Rename it'
    expect(dropRepeatedLines(fine)).toEqual({ text: fine, dropped: 0 })
  })
})
