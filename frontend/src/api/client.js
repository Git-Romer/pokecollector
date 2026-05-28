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
      const token = localStorage.getItem('token')
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      if (token && window.location.pathname !== '/login') {
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
export const getAuthMode = () => api.get('/auth/mode').then(r => r.data)
export const setAuthMode = (enabled) => api.put('/auth/mode', { enabled }).then(r => r.data)
export const getUsers = () => api.get('/auth/users').then(r => r.data)
export const createUser = (data) => api.post('/auth/users', data).then(r => r.data)
export const updateUser = (id, data) => api.put(`/auth/users/${id}`, data).then(r => r.data)
export const deleteUser = (id) => api.delete(`/auth/users/${id}`).then(r => r.data)
export const changePassword = (data) => api.put('/auth/me/password', data).then(r => r.data)
export const forceChangePassword = (newPassword) => api.put('/auth/me/force-password', { new_password: newPassword }).then(r => r.data)
export const changeAvatar = (avatarId) => api.put('/auth/me/avatar', { avatar_id: avatarId }).then(r => r.data)
export const changeUsername = (username) => api.put('/auth/me/username', { username }).then(r => r.data)


const formatApiErrorDetail = (detail) => {
  if (!detail) return ''
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail.map(formatApiErrorDetail).filter(Boolean).join('; ')
  }
  if (typeof detail === 'object') {
    const message = detail.msg || detail.message || detail.detail
    const loc = Array.isArray(detail.loc)
      ? detail.loc.filter(part => part !== 'body').join('.')
      : ''
    if (message) return loc ? `${loc}: ${formatApiErrorDetail(message)}` : formatApiErrorDetail(message)
    try {
      return JSON.stringify(detail)
    } catch {
      return ''
    }
  }
  return String(detail)
}

export const getApiErrorMessage = (error, fallback = 'Request failed') => {
  const detail = error?.response?.data?.detail ?? error?.response?.data?.message ?? error?.message
  return formatApiErrorDetail(detail) || fallback
}

// Cards
export const searchCards = (params) => api.get('/cards/search', { params })
export const getCard = (id) => api.get(`/cards/${id}`)
export const getCardInLang = (cardId, lang) => api.get(`/cards/${cardId}/lang/${lang}`)
export const getPriceHistory = (id) => api.get(`/cards/${id}/price-history`)
export const createCustomCard = (data) => api.post('/cards/custom', data)
export const updateCustomCard = (cardId, data) => api.put(`/cards/custom/${cardId}`, data).then(r => r.data)
export const updateCardCustomImage = (cardId, data) => api.put(`/cards/${cardId}/custom-image`, data).then(r => r.data)
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
export const getUserCollection = (userId, params = {}) => api.get(`/collection/user/${userId}`, { params }).then(r => r.data)
export const searchCollection = (params) => api.get('/collection/', { params })
export const addToCollection = (data) => api.post('/collection/', data)
export const bulkAddToCollection = (items) => api.post('/collection/bulk-add', { items }).then(r => r.data)
export const importCollectionCsv = (file) => {
  const formData = new FormData()
  formData.append('file', file)
  return api.post('/collection/import-csv', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data)
}
export const updateCollectionItem = (id, data) => api.put(`/collection/${id}`, data)
export const removeFromCollection = (id) => api.delete(`/collection/${id}`)
export const getCollectionStats = (params = {}) => api.get('/collection/stats/summary', { params })

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
export const getBinderCards = (id, params = {}) => api.get(`/binders/${id}/cards`, { params })
export const addCardToBinder = (binderId, cardId) => api.post(`/binders/${binderId}/cards?card_id=${cardId}`)
export const addCollectionItemToBinder = (binderId, collectionItemId) => api.post(`/binders/${binderId}/collection-items?collection_item_id=${collectionItemId}`)
export const updateBinderEntry = (binderId, binderCardId, data) => api.put(`/binders/${binderId}/entries/${binderCardId}`, data)
export const getBinderEntryEquivalentPrints = (binderId, binderCardId, params = {}) => api.get(`/binders/${binderId}/entries/${binderCardId}/equivalent-prints`, { params }).then(r => r.data)
export const getBinderPrintOptimization = (binderId, params = {}) => api.get(`/binders/${binderId}/optimize-prints`, { params }).then(r => r.data)
export const applyBinderPrintOptimization = (binderId, selectedBinderCardIds = null, params = {}) => api.post(`/binders/${binderId}/optimize-prints`, selectedBinderCardIds ? { selected_binder_card_ids: selectedBinderCardIds } : {}, { params }).then(r => r.data)
export const switchBinderEntryCard = (binderId, binderCardId, cardId, collectionItemId = null) => api.put(`/binders/${binderId}/entries/${binderCardId}/card`, { card_id: cardId, collection_item_id: collectionItemId }).then(r => r.data)
export const addBinderEntryToWishlist = (binderId, binderCardId) => api.post(`/binders/${binderId}/entries/${binderCardId}/wishlist`)
export const addBinderCardsToWishlist = (binderId) => api.post(`/binders/${binderId}/wishlist`).then(r => r.data)
export const removeCardFromBinder = (binderId, cardId) => api.delete(`/binders/${binderId}/cards/${cardId}`)
export const removeBinderEntry = (binderId, binderCardId) => api.delete(`/binders/${binderId}/entries/${binderCardId}`)
export const importBinderCsv = (binderId, file) => {
  const formData = new FormData()
  formData.append('file', file)
  return api.post(`/binders/${binderId}/import-csv`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data)
}
export const exportBinderCsv = (binderId) => {
  const token = localStorage.getItem('token')
  const config = { responseType: 'blob' }
  if (token) config.headers = { Authorization: `Bearer ${token}` }
  return api.get(`/binders/${binderId}/export-csv`, config).then(r => {
    const url = window.URL.createObjectURL(r.data)
    const a = document.createElement('a')
    a.href = url
    a.download = `binder-${binderId}.csv`
    document.body.appendChild(a)
    a.click()
    setTimeout(() => {
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)
    }, 0)
  })
}

// Dashboard
export const getDashboard = (params) => api.get('/dashboard/', { params })

// Analytics
export const getDuplicates = (params = {}) => api.get('/analytics/duplicates', { params })
export const getTopMovers = (days, params = {}) => api.get('/analytics/top-movers', { params: { ...params, days } })
export const getRarityStats = (params = {}) => api.get('/analytics/rarity-stats', { params })
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
export const exportCSV = (params = {}) => {
  const token = localStorage.getItem('token')
  const config = {
    responseType: 'blob',
    params,
  }
  if (token) {
    config.headers = { Authorization: `Bearer ${token}` }
  }
  return api.get('/export/csv', config).then(r => {
    const url = window.URL.createObjectURL(r.data)
    const a = document.createElement('a')
    a.href = url
    a.download = 'collection.csv'
    a.click()
    window.URL.revokeObjectURL(url)
  })
}
export const exportPDF = (params = {}) => {
  const token = localStorage.getItem('token')
  const config = {
    responseType: 'blob',
    params,
  }
  if (token) {
    config.headers = { Authorization: `Bearer ${token}` }
  }
  return api.get('/export/pdf', config).then(r => {
    const url = window.URL.createObjectURL(r.data)
    const a = document.createElement('a')
    a.href = url
    a.download = 'collection.pdf'
    a.click()
    window.URL.revokeObjectURL(url)
  })
}

// Backup
export const downloadBackup = (include = 'full') => {
  const token = localStorage.getItem('token')
  const config = {
    responseType: 'blob',
    params: { include },
  }
  if (token) {
    config.headers = { Authorization: `Bearer ${token}` }
  }
  return api.get('/backup/download', config).then(r => {
    const url = window.URL.createObjectURL(r.data)
    const a = document.createElement('a')
    a.href = url
    a.download = 'pokemon_tcg_backup.sql'
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

export const downloadDebugLog = () => {
  const token = localStorage.getItem('token')
  const config = { responseType: 'blob' }
  if (token) {
    config.headers = { Authorization: `Bearer ${token}` }
  }
  return api.get('/settings/debug-log', config).then(r => {
    const url = window.URL.createObjectURL(r.data)
    const a = document.createElement('a')
    a.href = url
    a.download = 'pokecollector-debug.log'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => window.URL.revokeObjectURL(url), 0)
  })
}

// GitHub / Community
export const getContributors = () => api.get('/github/contributors').then(r => r.data)
export const getSupporters = () => api.get('/github/supporters').then(r => r.data)

// Social
export const getLeaderboard = (params = {}) => api.get('/social/leaderboard', { params })
export const compareUsers = (userId, params = {}) => api.get(`/social/compare/${userId}`, { params })
export const getAchievements = (userId, params = {}) => api.get(`/social/achievements/${userId}`, { params })

export default api
