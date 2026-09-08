import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Hud } from './Hud.js'
import { Dashboard } from './Dashboard.js'
import './index.css'

// Two windows, one bundle. The hash decides which surface renders, which keeps
// the build simple and the preload identical for both.
const isHud = window.location.hash === '#/hud'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isHud ? <Hud /> : <Dashboard />}</StrictMode>
)
