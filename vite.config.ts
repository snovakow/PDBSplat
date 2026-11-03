import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the build runs from the site's pdbsplat/ folder
  base: '',
  build: {
    // The WebGPU build of three makes one chunk of about 2 MB; it's one scene, so it isn't split
    chunkSizeWarningLimit: 2500,
  },
})
