import { desktopCapturer, session } from 'electron'

/**
 * Answer the renderer's system-audio request ourselves, with no picker.
 *
 * WITHOUT THIS, `getDisplayMedia` FAILS. Electron denies the request when no
 * handler is installed, so this is not a convenience - it is the other half of
 * `renderer/capture/system.ts`.
 *
 * `useSystemPicker: false` is the load-bearing option. A picker means a dialog
 * on every single meeting, asking the person to choose a screen they do not
 * want to share in order to record audio they do. Spike V4 confirmed three
 * consecutive requests answered with no dialog at all.
 *
 * A VIDEO SOURCE IS SUPPLIED BECAUSE ELECTRON DEMANDS ONE. Answering with
 * `{ audio: 'loopback' }` alone throws `Video was requested, but no video
 * stream was provided`, and the callback is spent by then, so the request is
 * over. The renderer stops the video track the moment the stream arrives; the
 * capture pipeline never runs for the length of a meeting.
 *
 * `loopback` rather than `loopbackWithMute`: muting the far side while
 * recording it would be an odd thing to do to someone on a call.
 */
export function enableSystemAudioCapture(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] })
        const screen = sources[0]
        if (!screen) {
          // No screen to name means no way to satisfy the request. Cancelling
          // gives the renderer a rejected promise, which it reports; leaving it
          // unanswered would hang the meeting on nothing.
          callback({})
          return
        }
        callback({ video: screen, audio: 'loopback' })
      } catch {
        callback({})
      }
    },
    { useSystemPicker: false }
  )
}
