import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import '@mantine/core/styles.css'
// Atkinson Hyperlegible, self-hosted (the @fontsource package bundles the woff2 — no CDN call
// at runtime, which the privacy promise and offline-first design both require). DESIGN.md makes
// this face a functional legibility choice for low-vision readers, not a style one. The family
// ships two weights (400/700); 650 in the CSS resolves to the nearest, 700.
import '@fontsource/atkinson-hyperlegible/400.css'
import '@fontsource/atkinson-hyperlegible/700.css'
import '@fontsource/atkinson-hyperlegible/400-italic.css'
import './index.css'
import App from './App.tsx'
import { theme } from './theme'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme}>
      <App />
    </MantineProvider>
  </StrictMode>,
)
