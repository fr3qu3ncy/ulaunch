import { defineConfig, type Plugin } from 'vite'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

/* stamp backend/static/build.json with the git commit + date so the
   About screen can show which bundle is actually running */
function buildStamp(): Plugin {
  let commit = 'local-build'
  const date = new Date().toISOString().slice(0, 10)
  try {
    commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim()
  } catch { /* not a git checkout — keep the default */ }
  return {
    name: 'ulaunch-build-stamp',
    apply: 'build',
    closeBundle() {
      mkdirSync('../backend/static', { recursive: true })
      writeFileSync(
        '../backend/static/build.json',
        JSON.stringify({ commit, date }, null, 2),
      )
    },
  }
}

export default defineConfig({
  base: '/',
  plugins: [buildStamp()],
  build: {
    outDir: '../backend/static',
    emptyOutDir: true,
    target: 'es2020',
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8317' },
  },
})
