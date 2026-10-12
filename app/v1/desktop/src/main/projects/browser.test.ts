import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ WebContentsView: class {}, session: {} }))
import { previewUrl } from './browser.js'

describe('preview navigation', () => {
  it('accepts loopback previews and HTTPS', () => {
    expect(previewUrl('5173')).toBe('http://localhost:5173/')
    expect(previewUrl('localhost:3000/test')).toBe('http://localhost:3000/test')
    expect(previewUrl('http://[::1]:8080')).toBe('http://[::1]:8080/')
    expect(previewUrl('https://example.com')).toBe('https://example.com/')
  })
  it.each(['bump.fm', 'popu.fm', 'example.com/path?q=test'])('accepts a bare domain %s', url => {
    expect(previewUrl(url)).toBe(new URL('https://' + url).href)
  })
  it('allows public HTTP sites', () => { expect(previewUrl('http://example.com')).toBe('http://example.com/') })
  it.each(['file:///C:/Windows/system.ini', 'javascript:alert(1)', 'data:text/html,hello', 'https://user:password@example.com', 'wouice://settings', 'not a valid address'])('rejects %s', url => {
    expect(() => previewUrl(url)).toThrow()
  })
})
