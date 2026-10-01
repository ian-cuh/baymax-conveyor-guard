import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,        // listen on 0.0.0.0 so Docker/ngrok can reach it
    allowedHosts: true, // allow any host header (needed for ngrok tunnels)
  },
})
