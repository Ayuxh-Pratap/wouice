import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Hud } from './hud/Hud.js'
import { App } from './App.js'
import { isHudHash } from './shell/routes.js'
import './index.css'

// Two windows, one bundle. The hash decides which surface renders, which keeps
// the build simple and the preload identical for both - and the main window
// then uses the rest of the hash for its own routes.
const isHud = isHudHash(window.location.hash)

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isHud ? <Hud /> : <App />}</StrictMode>
)
