'use client'
import { useState } from 'react'

const inp = { width: '100%', padding: '10px 12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#fff', fontSize: 13, fontFamily: 'var(--body)', outline: 'none', boxSizing: 'border-box' }
const lbl = { fontSize: 10, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4, display: 'block', fontFamily: 'var(--mono)' }

export default function UserModal({ clients, onClose, onSave }) {
  const [form, setForm] = useState({ email: '', name: '', role: 'manager', client_id: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const upd = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const handleSave = async () => {
    if (!form.email.trim() || !form.name.trim()) { setError('Email and name are required'); return }
    setSaving(true)
    setError(null)
    try {
      await onSave(form)
      onClose()
    } catch (e) {
      setError(e.message)
      setSaving(false)
    }
  }

  const roles = [
    { id: 'admin', label: 'Admin', desc: 'Full access, all clients, settings, user management' },
    { id: 'manager', label: 'Case Manager', desc: 'Work debtors, send comms, upload intel. No settings.' },
    { id: 'viewer', label: 'Viewer', desc: 'Read-only dashboard and debtor list. No actions.' },
  ]

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, backdropFilter: 'blur(4px)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#13132a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, width: 460, padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <h3 style={{ margin: 0, fontSize: 16, color: '#fff' }}>Invite User</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', fontSize: 17, cursor: 'pointer' }}>x</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label style={lbl}>Name</label>
            <input style={inp} value={form.name} onChange={e => upd('name', e.target.value)} placeholder="Full name" />
          </div>
          <div>
            <label style={lbl}>Email</label>
            <input style={inp} type="email" value={form.email} onChange={e => upd('email', e.target.value)} placeholder="user@company.com" />
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>Role</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            {roles.map(r => (
              <button key={r.id} onClick={() => upd('role', r.id)} style={{
                padding: '10px 14px', background: form.role === r.id ? 'rgba(59,130,246,0.08)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${form.role === r.id ? 'rgba(59,130,246,0.25)' : 'rgba(255,255,255,0.05)'}`,
                borderRadius: 8, cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s'
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: form.role === r.id ? '#3b82f6' : 'rgba(255,255,255,0.6)' }}>{r.label}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', marginTop: 2 }}>{r.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {form.role !== 'admin' && (
          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Restrict to Client</label>
            <select style={{ ...inp, appearance: 'none' }} value={form.client_id} onChange={e => upd('client_id', e.target.value)}>
              <option value="">All clients (no restriction)</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', marginTop: 4 }}>If set, user only sees debtors belonging to this client</div>
          </div>
        )}

        {error && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 6 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ padding: '10px 18px', background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 7, color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 12 }}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={{
            padding: '10px 22px', background: saving ? 'rgba(59,130,246,0.3)' : '#3b82f6',
            border: 'none', borderRadius: 7, color: '#fff', cursor: saving ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600
          }}>{saving ? 'Inviting...' : 'Send Invite'}</button>
        </div>
      </div>
    </div>
  )
}
