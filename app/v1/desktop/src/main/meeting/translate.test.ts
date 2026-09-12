import { describe, expect, it } from 'vitest'
import { batchLines, batchUsable, parseEnglish, renderBatch, type Line } from './translate.js'

/**
 * Rendering a transcript into English, minus the model.
 *
 * The failure worth guarding against is not a bad translation - that is the
 * model's business - it is a mapping that drifts: a line rendered onto the
 * wrong moment, or half a batch silently left in Hindi while the rest appears
 * in English.
 */

const line = (id: number, text: string): Line => ({ id, text })

describe('batching', () => {
  it('gives every line a request of its own, so no answer can land on the wrong line', () => {
    const batches = batchLines([line(1, 'हाँ ठीक है'), line(2, 'okay')])
    expect(batches.map((b) => b.map((l) => l.id))).toEqual([[1], [2]])
  })

  it('splits when a batch would not fit with room to answer', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      line(i + 1, 'यह एक काफी लंबी लाइन है जिसमें कई शब्द हैं और यह जगह लेती है')
    )
    const batches = batchLines(many)
    expect(batches.length).toBeGreaterThan(1)
    // Every line survives exactly once, in order.
    expect(batches.flat().map((l) => l.id)).toEqual(many.map((l) => l.id))
  })

  it('skips blank lines', () => {
    expect(batchLines([line(1, '   ')])).toEqual([])
  })

  it('numbers each line with the id the answer must carry', () => {
    expect(renderBatch([line(42, 'कुछ तो है')])).toBe('[42] कुछ तो है')
  })

  it('names each line, and shows what was said just before as context only, unnumbered', () => {
    const batch = [{ id: 5, text: 'मैं कर दूंगा', speaker: 'Himanshu' }]
    const before = [{ id: 4, text: 'कौन करेगा', speaker: 'Priya' }]
    expect(renderBatch(batch, before)).toBe(
      ['Before this (context only):', '(Priya) कौन करेगा', '', 'Render only this:', '[5] (Himanshu) मैं कर दूंगा'].join('\n')
    )
  })

  it('shows only the end of a long line before, so it is not rendered in place of a short one', () => {
    const long = Array.from({ length: 60 }, (_, i) => `शब्द${i}`).join(' ')
    const text = renderBatch([{ id: 1, text: 'ठीक है' }], [{ id: 0, text: long }])
    expect(text).toContain(`… ${Array.from({ length: 20 }, (_, i) => `शब्द${i + 40}`).join(' ')}`)
    expect(text).not.toContain('शब्द39 ')
  })
})

describe('reading the rendering back', () => {
  const batch = [line(10, 'हाँ मैं भेज दूँगा'), line(11, 'ठीक है')]

  it('maps each line onto the one it came from', () => {
    const raw = '[10] Yes, I will send it\n[11] Okay'
    expect(parseEnglish(raw, batch)).toEqual([
      { id: 10, textEn: 'Yes, I will send it' },
      { id: 11, textEn: 'Okay' },
    ])
  })

  it('drops a number that was never sent', () => {
    // The model cannot have rendered a line it was not shown.
    expect(parseEnglish('[99] Something invented', batch)).toEqual([])
  })

  it('ignores anything that is not a numbered line', () => {
    const raw = ['Here is the translation:', '[10] Yes, I will send it', 'Hope that helps!'].join('\n')
    expect(parseEnglish(raw, batch).map((r) => r.id)).toEqual([10])
  })

  it('keeps the raw line when the model returned nothing for it', () => {
    // An empty answer is the model saying it could not carry the meaning, and
    // the original standing alone beats an invented English sentence.
    expect(parseEnglish('[10]  \n[11] Okay', batch).map((r) => r.id)).toEqual([11])
  })

  it('refuses a rendering far longer than the line', () => {
    const raw = `[11] ${'and then they went on at considerable length about '.repeat(6)}`
    expect(parseEnglish(raw, batch).map((r) => r.id)).toEqual([])
  })

  it("drops the speaker's name when the model repeats it", () => {
    const named = [{ id: 5, text: 'मैं कर दूंगा', speaker: 'Himanshu' }]
    expect(parseEnglish('[5] Himanshu: I will do it', named)).toEqual([{ id: 5, textEn: 'I will do it' }])
    expect(parseEnglish('[5] (Himanshu) I will do it', named)).toEqual([{ id: 5, textEn: 'I will do it' }])
  })

  it('takes an unnumbered answer to a single line as that line', () => {
    const one = [line(5, 'ठीक है ठीक है')]
    expect(parseEnglish('Okay, okay', one)).toEqual([{ id: 5, textEn: 'Okay, okay' }])
    expect(parseEnglish('Output: Okay, okay', one)).toEqual([{ id: 5, textEn: 'Okay, okay' }])
  })

  it('still reads a number with nothing after it as "could not", and never guesses for several lines', () => {
    expect(parseEnglish('[5]', [line(5, 'कुछ')])).toEqual([])
    expect(parseEnglish('Okay', batch)).toEqual([])
  })

  it('takes the first answer when a line is returned twice', () => {
    const raw = '[10] Yes, I will send it\n[10] Something else entirely'
    expect(parseEnglish(raw, batch)).toEqual([{ id: 10, textEn: 'Yes, I will send it' }])
  })
})

describe('whether a batch is worth keeping', () => {
  const batch = Array.from({ length: 20 }, (_, i) => line(i + 1, 'कुछ'))

  it('rejects a batch where the model lost the format', () => {
    // Three of twenty means seventeen lines silently stay in Hindi while three
    // appear in English - a half-rendered transcript nothing reports.
    const rendered = [1, 2, 3].map((id) => ({ id, textEn: 'something' }))
    expect(batchUsable(batch, rendered)).toBe(false)
  })

  it('accepts a batch that mostly came back', () => {
    const rendered = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, textEn: 'something' }))
    expect(batchUsable(batch, rendered)).toBe(true)
  })

  it('has nothing to complain about in an empty batch', () => {
    expect(batchUsable([], [])).toBe(true)
  })
})
