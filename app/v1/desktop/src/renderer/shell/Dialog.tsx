import { useEffect, useRef } from 'react'

/**
 * A dialog over the page, in the look MeetingPage's dialogs have.
 *
 * OVER THE PAGE, NOT IN IT. Opened in the page, a form pushes what is under it
 * down, and closing it leaves you somewhere else; over it, you come back to the
 * row you were on.
 *
 * A CLICK OUTSIDE CLOSES IT only when it also began outside: selecting the text
 * in a field and letting go past the edge is not a request to close.
 */
export function Dialog({
  title,
  onClose,
  wide = false,
  children,
}: {
  title: string
  onClose(): void
  wide?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const pressedOutside = useRef(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-6"
      role="presentation"
      onMouseDown={(e) => (pressedOutside.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (pressedOutside.current && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`lift w-full ${wide ? 'max-w-xl' : 'max-w-lg'} rounded-xl bg-neutral-900 px-5 py-4 ring-1 ring-white/[0.12]`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <h2 className="mb-3 text-[14px] font-medium text-neutral-100">{title}</h2>
        {children}
      </div>
    </div>
  )
}
