import { describe, expect, it } from 'vitest'
import { formatVocabularyUse } from './diagnostic.js'

describe('the vocabulary in a meeting diagnostic', () => {
  it('lists each entry said and written, and the lines to check first', () => {
    const out = formatVocabularyUse({
      at: 0,
      sent: 12,
      entries: [
        {
          term: 'Atlas',
          said: 0,
          written: 1,
          as: [],
          unheard: 1,
          check: [{ atMs: 286_000, said: 'ऑल्टो भी आ जाएगी', written: 'Atlas will also come' }],
        },
        { term: 'Claude', said: 1, written: 1, as: ['Lord'], unheard: 0, check: [] },
        { term: 'Qwen', said: 2, written: 0, as: ['coin'], unheard: 0, check: [] },
      ],
    })
    expect(out).toEqual([
      '  vocabulary    12 sent to the English; 3 said or written; 1 line(s) to check',
      '      Atlas' + ' '.repeat(10) + 'said 0, written 1  <- written 1x where nothing sounded like it',
      ' '.repeat(9) + '4:46  ऑल्टो भी आ जाएगी  ->  Atlas will also come',
      '      Claude' + ' '.repeat(9) + 'said 1, written 1  (heard as Lord)',
      '      Qwen' + ' '.repeat(11) + 'said 2, written 0  (heard as coin)  <- said, never written',
    ])
  })

  it('says nothing about lines to check when there are none', () => {
    expect(formatVocabularyUse({ at: 0, sent: 3, entries: [] })).toEqual(['  vocabulary    3 sent to the English; 0 said or written'])
  })
})
