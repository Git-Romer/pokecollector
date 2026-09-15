import axios from 'axios'

// A separate instance from api/client.js: NO Authorization header and NO 401->/login
// redirect, so anonymous visitors on public pages are never bounced to the login screen.
const publicApi = axios.create({
  baseURL: '/api/public',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
})

export const getPublicProfile = (handle) =>
  publicApi.get(`/profiles/${encodeURIComponent(handle)}`).then(r => r.data)

export const getPublicProfiles = () =>
  publicApi.get('/profiles').then(r => r.data)

export const getPublicBinder = (handle, binderId) =>
  publicApi.get(`/profiles/${encodeURIComponent(handle)}/binders/${binderId}`).then(r => r.data)

export const getPublicWishlist = (handle, params = {}) =>
  publicApi.get(`/profiles/${encodeURIComponent(handle)}/wishlist`, { params }).then(r => r.data)

export const getPublicDeck = (handle, deckId) =>
  publicApi.get(`/profiles/${encodeURIComponent(handle)}/decks/${deckId}`).then(r => r.data)

export const getPublicDeckProbability = (handle, deckId, params = {}) =>
  publicApi.get(`/profiles/${encodeURIComponent(handle)}/decks/${deckId}/probability`, { params }).then(r => r.data)
