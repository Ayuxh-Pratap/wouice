import { Metrics } from '../Metrics.js'

/**
 * Numbers only.
 *
 * Latency, degradation, GPU headroom, and which speech model is actually
 * faster. Nothing here is a control: everything you can change lives in
 * Settings, and everything you have said lives in Dictations. A page that
 * mixes the three is a page nobody can scan.
 */
export function DashboardPage(): React.JSX.Element {
  return <Metrics />
}
