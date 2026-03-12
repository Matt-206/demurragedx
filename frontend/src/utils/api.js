// api.js — Single source of truth for the backend base URL.
//
// How it resolves:
//   Local dev  → VITE_API_URL is unset → empty string → Vite proxy
//                forwards /api/* to localhost:3001 (vite.config.js)
//
//   Production → vercel.json rewrites /api/* to Railway, so the base URL
//                is still empty (requests stay on the same origin).
//                VITE_API_URL is only needed if you ever call Railway directly
//                from outside Vercel (e.g. a mobile app or Postman).
//
// Usage:
//   import { api } from './utils/api'
//   fetch(api('/api/forecast/demo_hamburg'))

export const API_BASE = import.meta.env.VITE_API_URL ?? ''

/**
 * api(path)
 * Prepends the base URL to an absolute path.
 * @param {string} path  Must start with '/'  e.g. '/api/forecast/demo_hamburg'
 * @returns {string}     Full URL ready for fetch()
 */
export function api(path) {
  return `${API_BASE}${path}`
}
