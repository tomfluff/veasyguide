import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// The commit that built this, for the feedback email's diagnostics block. Falls back for
// builds outside a git checkout (CI tarballs).
let commit = 'dev'
try {
  commit = execSync('git rev-parse --short HEAD').toString().trim()
} catch { /* not a git checkout */ }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __COMMIT__: JSON.stringify(commit),
  },
})
