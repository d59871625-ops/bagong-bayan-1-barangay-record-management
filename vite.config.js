import { env } from 'node:process'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const appBuildVersion = env.GITHUB_SHA || env.VITE_APP_BUILD_VERSION || 'local'

const appVersionPlugin = {
  name: 'emit-app-build-version',
  apply: 'build',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: JSON.stringify({ version: appBuildVersion }),
    })
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), appVersionPlugin],
  define: {
    'import.meta.env.VITE_APP_BUILD_VERSION': JSON.stringify(appBuildVersion),
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})
