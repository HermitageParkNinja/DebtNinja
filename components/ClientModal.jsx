'use client'
import { useState } from 'react'

const inp = { width: '100%', padding: '10px 12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#fff', fontSize: 13, fontFamily: 'var(--body)', outline: 'none', boxSizing: 'border-box' }
const lbl = { fontSize: 10, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4, display: 'block', fontFamily: 'var(--mono)' }

const COLORS = ['#3b82f6', '#a855f7', '#f59e0b', '#10b981', '#ef4444', '#ec4899', '#06b6d4', '#84cc16']

export default function ClientModal({ client, onClose, onSave }) {
  const isEdit = !!client?.id
  const [form, setForm] = useState({
    name: client?.name || '',
    contact_name: client?.contact_name || '',
    contact_email: client?.contact_email || '',
    color: client?.color || '#3b82f6',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const upd = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const handleSave = async () => {
    if (!form.name.trim()) { setError('Client name is required'); return }
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

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, backdropFilter: 'blur(4px)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#13132a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, width: 440, padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <h3 style={{ margin: 0, fontSize: 16, color: '#fff' }}>{isEdit ? 'Edit Client' : 'Add Client'}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', fontSize: 17, cursor: 'pointer' }}>x</button>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>Client Name</label>
          <input style={inp} value={form.name} onChange={e => upd('name', e.target.value)} placeholder="e.g. Revolution RTI" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label style={lbl}>Contact Name</label>
            <input style={inp} value={form.contact_name} onChange={e => upd('contact_name', e.target.value)} placeholder="e.g. Dean Smith" />
          </div>
          <div>
            <label style={lbl}>Contact Email</label>
            <input style={inp} value={form.contact_email} onChange={e => upd('contact_email', e.target.value)} placeholder="dean@rti.co.uk" />
          </div>
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={lbl}>Colour</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            {COLORS.map(c => (
              <button key={c} onClick={() => upd('color', c)} style={{
                width: 28, height: 28, borderRadius: 6, background: c, border: form.color === c ? '2px solid #fff' : '2px solid transparent',
                cursor: 'pointer', transition: 'all 0.15s', boxShadow: form.color === c ? `0 0 10px ${c}44` : 'none'
              }} />
            ))}
          </div>
        </div>

        {error && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 6 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ padding: '10px 18px', background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 7, color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 12 }}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={{
            padding: '10px 22px', background: saving ? 'rgba(59,130,246,0.3)' : '#3b82f6',
            border: 'none', borderRadius: 7, color: '#fff', cursor: saving ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600
          }}>{saving ? 'Saving...' : (isEdit ? 'Save Changes' : 'Add Client')}</button>
        </div>
      </div>
    </div>
  )
}
