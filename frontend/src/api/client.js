import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      if (window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

export const login = (username, password) => {
  const params = new URLSearchParams()
  params.append('username', username)
  params.append('password', password)
  return api.post('/auth/login', params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }).then(r => r.data)
}

export const getMe = () => api.get('/auth/me').then(r => r.data)

// Cards
export const searchCards = (params) => api.get('/cards/search', { params })
export const getCard = (id) => api.get(`/cards/${id}`)
export const getCardInLang = (cardId, lang) => api.get(`/cards/${cardId}/lang/${lang}`)
export const getPriceHistory = (id) => api.get(`/cards/${id}/price-history`)
export const createCustomCard = (data) => api.post('/cards/custom', data)
export const updateCustomCard = (cardId, data) => api.put(`/cards/custom/${cardId}`, data).then(r => r.data)
export const deleteCustomCard = (cardId) => api.delete(`/cards/custom/${cardId}`)
export const getCustomCards = () => api.get('/cards/custom')

// Card recognition via Gemini Vision
export const recognizeCard = (imageFile) => {
  const formData = new FormData()
  formData.append('file', imageFile)
  return api.post('/cards/recognize', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data)
}

// Custom card migration
export const getCustomMatches = () => api.get('/cards/custom/matches')
export const migrateCustomCard = (matchId) => api.post(`/cards/custom/migrate/${matchId}`)
export const dismissCustomMatch = (matchId) => api.post(`/cards/custom/dismiss/${matchId}`)

// Collection
export const getCollection = (params) => api.get('/collection/', { params })
export const searchCollection = (params) => api.get('/collection/', { params })
export const addToCollection = (data) => api.post('/collection/', data)
export const updateCollectionItem = (id, data) => api.put(`/collection/${id}`, data)
export const removeFromCollection = (id) => api.delete(`/collection/${id}`)
export const getCollectionStats = () => api.get('/collection/stats/summary')

// Sets
export const getSets = (params) => api.get('/sets/', { params })
export const getSet = (id) => api.get(`/sets/${id}`)
export const getSetChecklist = (id) => api.get(`/sets/${id}/checklist`)
export const getNewSets = () => api.get('/sets/new')
export const markSetsSeen = () => api.post('/sets/mark-seen')

// Wishlist
export const getWishlist = () => api.get('/wishlist/')
export const addToWishlist = (data) => api.post('/wishlist/', data)
export const updateWishlistItem = (id, data) => api.put(`/wishlist/${id}`, data)
export const removeFromWishlist = (id) => api.delete(`/wishlist/${id}`)

// Binders
export const getBinders = () => api.get('/binders/')
export const createBinder = (data) => api.post('/binders/', data)
export const updateBinder = (id, data) => api.put(`/binders/${id}`, data)
export const deleteBinder = (id) => api.delete(`/binders/${id}`)
export const getBinderCards = (id) => api.get(`/binders/${id}/cards`)
export const addCardToBinder = (binderId, cardId) => api.post(`/binders/${binderId}/cards?card_id=${cardId}`)
export const removeCardFromBinder = (binderId, cardId) => api.delete(`/binders/${binderId}/cards/${cardId}`)

// Dashboard
export const getDashboard = (params) => api.get('/dashboard/', { params })

// Analytics
export const getDuplicates = () => api.get('/analytics/duplicates')
export const getTopMovers = (days) => api.get('/analytics/top-movers', { params: { days } })
export const getRarityStats = () => api.get('/analytics/rarity-stats')
export const getInvestmentTracker = (params = {}) => api.get('/analytics/investment-tracker', { params })
export const getAnalyticsNewSets = () => api.get('/analytics/new-sets')

// Sync
export const triggerSync = () => api.post('/sync/')
export const triggerPriceSync = () => api.post('/sync/prices')
export const getSyncStatus = () => api.get('/sync/status')
export const rescheduleFullSync = (intervalDays) => api.post('/sync/reschedule-full', { interval_days: intervalDays })
export const reschedulePriceSync = (intervalMinutes) => api.post('/sync/reschedule-prices', { interval_minutes: intervalMinutes })

// Products
export const getProducts = () => api.get('/products/')
export const getProductTypes = () => api.get('/products/types')
export const createProduct = (data) => api.post('/products/', data)
export const updateProduct = (id, data) => api.put(`/products/${id}`, data)
export const deleteProduct = (id) => api.delete(`/products/${id}`)
export const getProductsSummary = () => api.get('/products/summary')

// Export
export const exportCSV = () => {
  const token = localStorage.getItem('token')
  return api.get('/export/csv', {
    responseType: 'blob',
    headers: { Authorization: `Bearer ${token}` },
  }).then(r => {
    const url = window.URL.createObjectURL(r.data)
    const a = document.createElement('a')
    a.href = url
    a.download = 'collection.csv'
    a.click()
    window.URL.revokeObjectURL(url)
  })
}
export const exportPDF = () => {
  const token = localStorage.getItem('token')
  return api.get('/export/pdf', {
    responseType: 'blob',
    headers: { Authorization: `Bearer ${token}` },
  }).then(r => {
    const url = window.URL.createObjectURL(r.data)
    const a = document.createElement('a')
    a.href = url
    a.download = 'collection.pdf'
    a.click()
    window.URL.revokeObjectURL(url)
  })
}

// Backup
export const downloadBackup = () => {
  const token = localStorage.getItem('token')
  return api.get('/backup/download', {
    responseType: 'blob',
    headers: { Authorization: `Bearer ${token}` },
  }).then(r => {
    const url = window.URL.createObjectURL(r.data)
    const a = document.createElement('a')
    a.href = url
    a.download = 'backup.sql'
    a.click()
    window.URL.revokeObjectURL(url)
  })
}
export const restoreBackup = (file) => {
  const formData = new FormData()
  formData.append('file', file)
  return api.post('/backup/restore', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
}

// Settings
export const getSettings = () => api.get('/settings/')
export const saveSettings = (data) => api.put('/settings/', data)
export const getSetting = (key) => api.get(`/settings/${key}`).then(r => r.data)
export const setSetting = (key, value) => api.post(`/settings/${key}`, { value }).then(r => r.data)
export const getTelegramStatus = () => api.get('/settings/telegram_status').then(r => r.data)

// eBay
export const getEbayGradedPrice = (cardName, grade, lang = 'en') =>
  api.get('/ebay/graded-price', { params: { card_name: cardName, grade, lang } }).then(r => r.data)

export default api
