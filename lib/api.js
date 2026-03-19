// API client for Ashveil frontend
// Wraps all backend calls with error handling

const API_BASE = '/api'

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || 'Request failed')
  }
  return res.json()
}

export const api = {
  // Debtors
  getDebtors: (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request(`/debtors${qs ? '?' + qs : ''}`)
  },
  createDebtor: (data) => request('/debtors', { method: 'POST', body: JSON.stringify(data) }),
  updateDebtor: (id, data) => request('/debtors', { method: 'PATCH', body: JSON.stringify({ id, ...data }) }),

  // Intelligence (AI analysis)
  analyseDocuments: (debtorId, type, documentsText) =>
    request('/intelligence', {
      method: 'POST',
      body: JSON.stringify({ debtor_id: debtorId, type, documents_text: documentsText }),
    }),

  // Stripe
  generatePaymentLink: (debtorId) =>
    request('/stripe', { method: 'POST', body: JSON.stringify({ debtor_id: debtorId }) }),

  // Documents
  uploadDocuments: async (debtorId, files) => {
    const formData = new FormData()
    formData.append('debtor_id', debtorId)
    files.forEach(f => formData.append('files', f))
    const res = await fetch(`${API_BASE}/documents`, { method: 'POST', body: formData })
    if (!res.ok) throw new Error('Upload failed')
    return res.json()
  },
}
