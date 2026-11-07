import { Leva } from 'leva'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Wide enough for the longest label inside a folder, Bloom threshold, beside the scrollbar a panel taller than the
// window shows
const panelTheme = { sizes: { rootWidth: '340px' } }

// The leva panel renders outside StrictMode, whose second run of a folder's effects pins the folder at its first
// height, so a control a style shows would draw over the folder below. It comes first, so that it's in place
// before the panel's controls look for a panel and would otherwise mount one of their own
createRoot(document.getElementById('root')!).render(
  <>
    <Leva theme={panelTheme} />
    <StrictMode>
      <App />
    </StrictMode>
  </>,
)
