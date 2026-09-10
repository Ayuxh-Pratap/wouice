import { useEffect, useState } from 'react'
import type { MeetingJobKind, MeetingJobsView } from '../../shared/ipc.js'

/**
 * What the app is doing to meetings right now, from the one place that knows.
 *
 * Asked for on mount and then pushed, so a page opened halfway through a run
 * shows it running - rather than waiting for the next progress message, which
 * is how a busy meeting used to look idle.
 */
export function useMeetingJobs(): MeetingJobsView {
  const [jobs, setJobs] = useState<MeetingJobsView>({ running: null, queued: [] })
  useEffect(() => {
    void window.wouice.getMeetingJobs().then(setJobs)
    return window.wouice.onMeetingJobs(setJobs)
  }, [])
  return jobs
}

/** Orange for the careful pass, which costs you dictation; green for the rest. */
export function jobColour(kind: MeetingJobKind): string {
  return kind === 'improve' ? '#fb923c' : '#34d399'
}

export function describeJob(kind: MeetingJobKind): string {
  switch (kind) {
    case 'improve':
      return 'Improving accuracy'
    case 'english':
      return 'Rendering into English'
    case 'notes':
      return 'Writing the summary and tasks'
    default:
      return 'Writing the English, summary and tasks'
  }
}
