import { useEffect, useState } from 'react'
import type { Diagnostics, SidecarView } from '../../shared/ipc.js'
import type { Settings } from '../../shared/settings.js'
import type { SidecarId } from '../../shared/models.js'
import { Calibration } from '../calibration/Calibration.js'
import { SettingsPanel } from '../settings/Settings.js'
import { SidecarCard } from '../settings/ModelCards.js'
import { Storage } from '../settings/Storage.js'

/**
 * Everything you can change, in the order you are likely to need it.
 *
 * Voice first, because calibration and the microphone are what make the app
 * work at all. Then the ordinary preferences. Then the models, which are a
 * real choice but not a frequent one. Then diagnostics, which are for when
 * something is wrong.
 *
 * The last two are developer material and appear only with developer mode on -
 * a model picker in front of someone who has just installed this is a question
 * they have no way to answer.
 */
export function SettingsPage({ settings }: { settings: Settings | null }): React.JSX.Element {
  const [sidecars, setSidecars] = useState<SidecarView[]>([])
  const [diag, setDiag] = useState<Diagnostics | null>(null)

  useEffect(() => {
    void window.wouice.getSidecars().then(setSidecars)
    void window.wouice.getDiagnostics().then(setDiag)
    return window.wouice.onSidecarState((next) =>
      setSidecars((prev) => {
        const i = prev.findIndex((s) => s.id === next.id)
        if (i === -1) return [...prev, next]
        const copy = [...prev]
        copy[i] = next
        return copy
      })
    )
  }, [])

  const dev = settings?.developerMode ?? false
  const switchModel = (id: SidecarId, modelId: string): void => {
    void window.wouice.switchModel(id, modelId)
  }

  return (
    <div className="space-y-4">
      <Calibration settings={settings} variant="card" />

      <SettingsPanel settings={settings} />

      {dev && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {sidecars.map((s) => (
              <SidecarCard
                key={s.id}
                view={s}
                onSwitch={(modelId) => switchModel(s.id, modelId)}
                onRestart={() => void window.wouice.restartSidecar(s.id)}
              />
            ))}
          </div>

          {diag && (
            <section className="lift rounded-xl bg-white/[0.035] px-4 py-3 ring-1 ring-white/[0.08]">
              <h3 className="text-[13px] font-semibold text-neutral-100">Diagnostics</h3>
              <p className="mt-0.5 text-[11px] text-neutral-500">
                Where everything lives, and what the app managed to claim at startup.
              </p>
              <dl className="mt-3 grid gap-x-4 gap-y-1.5 font-mono text-[11px] sm:grid-cols-[auto_1fr]">
                {[
                  ['sidecars', diag.sidecarRoot],
                  ['models', diag.modelRoot],
                  ['user data', diag.userData],
                  ['platform', diag.platform],
                  ['electron', diag.electron],
                  [
                    'hotkeys',
                    Object.entries(diag.hotkeyRegistered)
                      .map(([k, v]) => `${k}=${v ? 'ok' : 'FAILED'}`)
                      .join('  ') || 'none',
                  ],
                ].map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-neutral-500">{k}</dt>
                    <dd className="truncate text-neutral-300">{v}</dd>
                  </div>
                ))}
              </dl>
              <Storage />
            </section>
          )}
        </>
      )}
    </div>
  )
}
