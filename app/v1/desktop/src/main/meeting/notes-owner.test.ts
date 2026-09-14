import { describe, expect, it } from 'vitest'
import { committedOwner } from './notes.js'

/** Who a task goes to when the model names nobody: whoever took it on in so many words. */
describe('who committed to the work', () => {
  it('is the one speaker who said "I will", in English or in Hindi', () => {
    // Meeting 18: Himanshu's own line, and the task went to nobody.
    expect(
      committedOwner([{ channel: 'them', speaker: 'Himanshu', text: 'Brother, look, the navigation and highlight are working, I will also add search' }])
    ).toBe('Himanshu')
    expect(committedOwner([{ channel: 'me', speaker: 'Ayush Pratap Singh', text: 'मैं आपको एक रजिस्ट्री भेज दूंगा' }])).toBe('You')
    expect(committedOwner([{ channel: 'them', speaker: null, text: "I'll send it on Monday" }])).toBe('Them')
  })

  it('is nobody when the line says "we", someone else, or when two people both said it', () => {
    expect(committedOwner([{ channel: 'them', speaker: 'Himanshu', text: 'we need to include follow up questions' }])).toBeNull()
    expect(committedOwner([{ channel: 'them', speaker: 'Himanshu', text: 'he will send the registry' }])).toBeNull()
    expect(
      committedOwner([
        { channel: 'them', speaker: 'Himanshu', text: 'I will build it' },
        { channel: 'me', speaker: 'Ayush Pratap Singh', text: "I'll send the registry" },
      ])
    ).toBeNull()
  })
})
