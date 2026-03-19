'use client'
import { useState, useEffect, useCallback } from 'react'
import { createBrowserClient } from '@/lib/supabase'

const supabase = createBrowserClient()

// ── Fetch current user profile ──
export function useUser() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.user) {
        const { data } = await supabase
          .from('users')
          .select('*')
          .eq('id', session.user.id)
          .single()
        setUser(data || { id: session.user.id, email: session.user.email, name: session.user.email, role: 'admin' })
      }
      setLoading(false)
    }
    load()
  }, [])

  return { user, loading }
}

// ── Fetch clients ──
export function useClients() {
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const { data } = await supabase.from('clients').select('*').eq('active', true).order('name')
    setClients(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const addClient = async (client) => {
    const { data, error } = await supabase.from('clients').insert(client).select().single()
    if (!error) await refresh()
    return { data, error }
  }

  const updateClient = async (id, updates) => {
    const { data, error } = await supabase.from('clients').update(updates).eq('id', id).select().single()
    if (!error) await refresh()
    return { data, error }
  }

  const deleteClient = async (id) => {
    const { error } = await supabase.from('clients').update({ active: false }).eq('id', id)
    if (!error) await refresh()
    return { error }
  }

  return { clients, loading, refresh, addClient, updateClient, deleteClient }
}

// ── Fetch users ──
export function useUsers() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const { data } = await supabase.from('users').select('*, clients(name)').order('name')
    setUsers(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const inviteUser = async (email, name, role, clientId) => {
    // Create auth user via admin API (needs service role - hit our API route)
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name, role, client_id: clientId }),
    })
    const result = await res.json()
    if (res.ok) await refresh()
    return result
  }

  return { users, loading, refresh, inviteUser }
}

// ── Fetch debtors ──
export function useDebtors() {
  const [debtors, setDebtors] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from('debtors')
      .select(`
        *,
        intelligence(confidence, claim_strength, claims, assets, flags, breakdown, total_recoverable),
        timeline(id, sequence_day, channel, direction, status, result, summary, transcript, executed_at),
        documents(id, filename, doc_type, file_size),
        clients(id, name, color)
      `)
      .order('created_at', { ascending: false })
    setDebtors(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const addDebtor = async (debtor) => {
    const { data, error } = await supabase.from('debtors').insert(debtor).select().single()
    if (!error) await refresh()
    return { data, error }
  }

  const updateDebtor = async (id, updates) => {
    const { data, error } = await supabase.from('debtors').update(updates).eq('id', id).select().single()
    if (!error) await refresh()
    return { data, error }
  }

  return { debtors, loading, refresh, addDebtor, updateDebtor }
}

// ── Upload documents via API (gets PDF text extraction) ──
export async function uploadDocuments(debtorId, files) {
  const formData = new FormData()
  formData.append('debtor_id', debtorId)
  for (const file of files) {
    formData.append('files', file)
  }
  const res = await fetch('/api/documents', { method: 'POST', body: formData })
  if (!res.ok) throw new Error('Upload failed')
  return res.json()
}

// ── Run intelligence analysis ──
export async function runIntelligence(debtorId, type, documentsText) {
  const res = await fetch('/api/intelligence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ debtor_id: debtorId, type, documents_text: documentsText }),
  })
  return res.json()
}

// ── Generate Stripe payment link ──
export async function generatePaymentLink(debtorId) {
  const res = await fetch('/api/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ debtor_id: debtorId }),
  })
  return res.json()
}

// ── Send email ──
export async function sendEmail(debtorId, template, customSubject, customBody) {
  const res = await fetch('/api/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ debtor_id: debtorId, template, custom_subject: customSubject, custom_body: customBody }),
  })
  return res.json()
}

// ── Send SMS or WhatsApp ──
export async function sendSMS(debtorId, channel, template, customMessage) {
  const res = await fetch('/api/sms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ debtor_id: debtorId, channel: channel || 'sms', template, custom_message: customMessage }),
  })
  return res.json()
}

// ── Make AI call ──
export async function makeCall(debtorId, tone) {
  const res = await fetch('/api/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ debtor_id: debtorId, tone: tone || 'professional' }),
  })
  return res.json()
}

// ── Sign out ──
export async function signOut() {
  await supabase.auth.signOut()
  window.location.reload()
}

// ── Health check - which services are configured ──
export function useHealth() {
  const [health, setHealth] = useState({})
  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then(setHealth).catch(() => {})
  }, [])
  return health
}
