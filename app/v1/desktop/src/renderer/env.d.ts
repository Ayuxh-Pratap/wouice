/// <reference types="vite/client" />
import type { WouiceApi } from '../shared/ipc.js'

declare global {
  interface Window {
    wouice: WouiceApi
  }
}
