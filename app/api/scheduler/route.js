import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
 
// Sequence definitions
const SEQUENCES = {
  high: [
    { day: 1, channel: "email", template: "initial_demand", auto: true },
    { day: 1, channel: "payment", auto: true },
    { day: 3, channel: "call", tone: "professional", auto: true },
    { day: 5, channel: "sms", template: "initial_chase", auto: true },
    { day: 7, channel: "email", template: "second_demand", auto: true },
    { day: 10, channel: "call", tone: "firm", auto: true },
    { day: 12, channel: "whatsapp", template: "urgent", auto: true },
    { day: 14, channel: "letter", auto: false },
    { day: 21, channel: "call", tone: "final", auto: true },
    { day: 28, channel: "legal", auto: false },
  ],
  medium: [
    { day: 1, channel: "email", template: "initial_demand", auto: true },
    { day: 1, channel: "payment", auto: true },
    { day: 5, channel: "sms", template: "initial_chase", auto: true },
    { day: 10, channel: "call", tone: "professional", auto: true },
    { day: 14, channel: "email", template: "second_demand", auto: true },
    { day: 18, channel: "whatsapp", template: "payment_reminder", auto: true },
    { day: 21, channel: "call", tone: "firm", auto: true },
    { day: 28, channel: "letter", auto: false },
    { day: 35, channel: "email", template: "final_demand", auto: true },
    { day: 42, channel: "legal", auto: false },
  ],
  low: [
    { day: 1, channel: "email", template: "initial_demand", auto: true },
    { day: 1, channel: "payment", auto: true },
    { day: 7, channel: "sms", template: "initial_chase", auto: true },
    { day: 14, channel: "email", template: "second_demand", auto: true },
    { day: 21, channel: "whatsapp", template: "payment_reminder", auto: true },
    { day: 28, channel: "email", template: "final_demand", auto: true },
    { day: 35, channel: "sms", template: "final", auto: true },
    { day: 42, channel: "legal", auto: false },
  ],
}
 
const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
 
async function fireAction(step, debtorId) {
  try {
    if (step.channel === 'email') {
      await fetch(`${BASE_URL}/api/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debtor_id: debtorId, template: step.template }),
      })
    } else if (step.channel === 'sms') {
      await fetch(`${BASE_URL}/api/sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debtor_id: debtorId, channel: 'sms', template: step.template }),
      })
    } else if (step.channel === 'whatsapp') {
      await fetch(`${BASE_URL}/api/sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debtor_id: debtorId, channel: 'whatsapp', template: step.template }),
      })
    } else if (step.channel === 'call') {
      await fetch(`${BASE_URL}/api/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debtor_id: debtorId, tone: step.tone || 'professional' }),
      })
    } else if (step.channel === 'payment') {
      await fetch(`${BASE_URL}/api/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debtor_id: debtorId }),
      })
    }
    return true
  } catch (err) {
    console.error(`Failed to fire ${step.channel} for debtor ${debtorId}:`, err)
    return false
  }
}
 
function getNextAction(sequence, currentDay) {
  const future = sequence.filter(s => s.day > currentDay).sort((a, b) => a.day - b.day)
  if (future.length === 0) return 'Sequence complete'
  const next = future[0]
  const channelLabels = { email: 'Email', sms: 'SMS', call: 'AI Call', whatsapp: 'WhatsApp', letter: 'Letter', payment: 'Stripe link', legal: 'Legal review' }
  return `Day ${next.day}: ${channelLabels[next.channel] || next.channel}`
}
 
// Main scheduler - handles sequences and scheduled callbacks
export async function GET(request) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
 
  const supabase = createServerClient()
  const now = new Date()
  const results = { processed: 0, fired: 0, skipped: 0, errors: 0, callbacks_fired: 0, manual_required: [], details: [] }
 
  // UK working hours check - 9am to 6pm Mon-Fri
  const ukTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }))
  const ukHour = ukTime.getHours()
  const ukDay = ukTime.getDay()
 
  if (ukHour < 9 || ukHour >= 18 || ukDay === 0 || ukDay === 6) {
    return NextResponse.json({ message: 'Outside working hours (09:00-18:00 Mon-Fri UK)', skipped: true })
  }
 
  // ── 1. SCHEDULED CALLBACKS ──
  // Find callbacks that are due (scheduled_at is in the past or within next 30 mins)
  const thirtyMinsFromNow = new Date(now.getTime() + 30 * 60 * 1000)
  const { data: callbacks } = await supabase
    .from('timeline')
    .select('debtor_id, metadata')
    .eq('status', 'scheduled')
    .eq('channel', 'call')
    .lte('scheduled_at', thirtyMinsFromNow.toISOString())
 
  if (callbacks && callbacks.length > 0) {
    for (const cb of callbacks) {
      try {
        // Fire the callback
        await fetch(`${BASE_URL}/api/call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ debtor_id: cb.debtor_id, tone: 'professional' }),
        })
 
        // Mark the scheduled entry as sent
        await supabase
          .from('timeline')
          .update({ status: 'sent', result: 'callback_fired', executed_at: now.toISOString() })
          .eq('debtor_id', cb.debtor_id)
          .eq('status', 'scheduled')
          .eq('channel', 'call')
 
        results.callbacks_fired++
      } catch (e) {
        console.error('Callback failed:', e)
      }
    }
  }
 
  // ── 2. SEQUENCE PROCESSING ──
  const { data: debtors, error } = await supabase
    .from('debtors')
    .select('*')
    .in('status', ['queued', 'active'])
    .eq('sequence_paused', false)
 
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
 
  for (const debtor of debtors) {
    results.processed++
 
    // Calculate sequence day
    const startDate = debtor.sequence_started_at ? new Date(debtor.sequence_started_at) : new Date(debtor.created_at)
    const daysSinceStart = Math.floor((now - startDate) / 86400000)
    const currentDay = daysSinceStart + 1
 
// Skip if we've already processed this day for this debtor
    if (debtor.sequence_day >= currentDay && debtor.sequence_day > 0) {
      results.skipped++
      continue
    }
 
    // Get the sequence for this debtor's priority
    const sequence = SEQUENCES[debtor.priority] || SEQUENCES.medium
 
    // Find steps that should fire today
    const todaysSteps = sequence.filter(step => step.day === currentDay)
 
    if (todaysSteps.length === 0) {
      results.skipped++
      // Still update the sequence day
      if (debtor.sequence_day !== currentDay) {
        await supabase.from('debtors').update({
          sequence_day: currentDay,
          sequence_started_at: debtor.sequence_started_at || now.toISOString(),
          next_action: getNextAction(sequence, currentDay),
        }).eq('id', debtor.id)
      }
      continue
    }
 
    for (const step of todaysSteps) {
     
      // Manual steps - flag for human attention
      if (!step.auto) {
        results.manual_required.push({
          debtor_id: debtor.id,
          company: debtor.company,
          name: debtor.name,
          day: currentDay,
          channel: step.channel,
        })
 
        await supabase.from('timeline').insert({
          debtor_id: debtor.id,
          sequence_day: currentDay,
          channel: step.channel,
          direction: 'out',
          status: 'pending',
          summary: `MANUAL ACTION REQUIRED: ${step.channel} on day ${currentDay}`,
          executed_at: now.toISOString(),
        })
        continue
      }
 
      // Fire the action
      const success = await fireAction(step, debtor.id)
 
      if (success) {
        results.fired++
        results.details.push({ debtor: debtor.company, day: currentDay, channel: step.channel, status: 'fired' })
      } else {
        results.errors++
      }
    }
 
    // Update debtor
    await supabase.from('debtors').update({
      sequence_day: currentDay,
      status: currentDay === 1 && debtor.status === 'queued' ? 'active' : debtor.status,
      sequence_started_at: debtor.sequence_started_at || now.toISOString(),
      next_action: getNextAction(sequence, currentDay),
    }).eq('id', debtor.id)
  }
 
  // ── 3. DAILY DIRECTOR EMAIL (8pm check) ──
  if (ukHour === 17) { // Run at 5-6pm slot (last cron before end of day)
    try {
      await sendDailyDirectorEmail(supabase)
      results.details.push({ action: 'daily_email', status: 'sent' })
    } catch (e) {
      console.error('Daily email failed:', e)
    }
  }
 
  return NextResponse.json({
    success: true,
    timestamp: now.toISOString(),
    ...results,
  })
}
 
// Daily director summary email
async function sendDailyDirectorEmail(supabase) {
  // Get today's activity
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
 
  const { data: todaysTimeline } = await supabase
    .from('timeline')
    .select('*, debtors(name, company, status, payments, base_amount, principal)')
    .gte('executed_at', todayStart.toISOString())
    .order('executed_at', { ascending: false })
 
  if (!todaysTimeline || todaysTimeline.length === 0) return
 
  // Get all active debtors for tomorrow's preview
  const { data: activeDebtors } = await supabase
    .from('debtors')
    .select('name, company, priority, sequence_day, next_action, status')
    .in('status', ['queued', 'active'])
    .eq('sequence_paused', false)
 
  // Build the email
  const calls = todaysTimeline.filter(t => t.channel === 'call' && t.result !== 'initiated')
  const payments = todaysTimeline.filter(t => t.channel === 'payment' && t.direction === 'in')
  const emails = todaysTimeline.filter(t => t.channel === 'email' && t.direction === 'out')
  const smsSent = todaysTimeline.filter(t => (t.channel === 'sms' || t.channel === 'whatsapp') && t.direction === 'out')
  const disputes = todaysTimeline.filter(t => t.result === 'disputed' || t.result === 'dispute_detected')
  const vulnerable = todaysTimeline.filter(t => t.result === 'vulnerable')
  const inboundReplies = todaysTimeline.filter(t => t.direction === 'in' && t.channel !== 'payment')
 
  const totalRecovered = payments.reduce((s, p) => {
    const amt = p.metadata?.amount || 0
    return s + amt
  }, 0)
 
  let html = `
    <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; color: #333;">
      <div style="background: #0c0c18; padding: 20px 24px; border-radius: 8px 8px 0 0;">
        <h1 style="color: #fff; margin: 0; font-size: 18px;">Ashveil Daily Summary</h1>
        <p style="color: rgba(255,255,255,0.5); margin: 4px 0 0; font-size: 13px;">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
      </div>
 
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 20px 24px;">
 
        <div style="display: flex; gap: 12px; margin-bottom: 20px;">
          <div style="flex: 1; background: #f0fdf4; padding: 12px; border-radius: 6px; text-align: center;">
            <div style="font-size: 11px; color: #666; text-transform: uppercase;">Recovered Today</div>
            <div style="font-size: 22px; font-weight: 700; color: #16a34a;">£${totalRecovered.toLocaleString('en-GB', { minimumFractionDigits: 2 })}</div>
          </div>
          <div style="flex: 1; background: #eff6ff; padding: 12px; border-radius: 6px; text-align: center;">
            <div style="font-size: 11px; color: #666; text-transform: uppercase;">Calls Made</div>
            <div style="font-size: 22px; font-weight: 700; color: #2563eb;">${calls.length}</div>
          </div>
          <div style="flex: 1; background: #fefce8; padding: 12px; border-radius: 6px; text-align: center;">
            <div style="font-size: 11px; color: #666; text-transform: uppercase;">Comms Sent</div>
            <div style="font-size: 22px; font-weight: 700; color: #ca8a04;">${emails.length + smsSent.length}</div>
          </div>
        </div>`
 
  // Disputes / Vulnerable - urgent flags
  if (disputes.length > 0 || vulnerable.length > 0) {
    html += `<div style="background: #fef2f2; border: 1px solid #fecaca; padding: 12px; border-radius: 6px; margin-bottom: 16px;">
      <div style="font-weight: 700; color: #dc2626; font-size: 13px; margin-bottom: 6px;">⚠️ REQUIRES ATTENTION</div>`
    disputes.forEach(d => {
      html += `<div style="font-size: 12px; color: #991b1b; margin-bottom: 3px;">DISPUTED: ${d.debtors?.company || 'Unknown'} - ${d.summary || ''}</div>`
    })
    vulnerable.forEach(v => {
      html += `<div style="font-size: 12px; color: #991b1b; margin-bottom: 3px;">VULNERABLE: ${v.debtors?.company || 'Unknown'} - ${v.summary || ''}</div>`
    })
    html += `</div>`
  }
 
  // Call outcomes
  if (calls.length > 0) {
    html += `<div style="margin-bottom: 16px;">
      <div style="font-weight: 700; font-size: 13px; margin-bottom: 8px; color: #111;">📞 Call Outcomes</div>
      <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
        <tr style="background: #f9fafb;"><th style="text-align: left; padding: 6px 8px; border: 1px solid #e5e7eb;">Company</th><th style="text-align: left; padding: 6px 8px; border: 1px solid #e5e7eb;">Outcome</th><th style="text-align: left; padding: 6px 8px; border: 1px solid #e5e7eb;">Summary</th></tr>`
    calls.forEach(c => {
      const outcome = (c.result || 'completed').replace(/_/g, ' ')
      html += `<tr><td style="padding: 6px 8px; border: 1px solid #e5e7eb;">${c.debtors?.company || 'Unknown'}</td><td style="padding: 6px 8px; border: 1px solid #e5e7eb;">${outcome}</td><td style="padding: 6px 8px; border: 1px solid #e5e7eb;">${(c.summary || '').substring(0, 100)}</td></tr>`
    })
    html += `</table></div>`
  }
 
  // Payments received
  if (payments.length > 0) {
    html += `<div style="margin-bottom: 16px;">
      <div style="font-weight: 700; font-size: 13px; margin-bottom: 8px; color: #111;">💷 Payments Received</div>`
    payments.forEach(p => {
      html += `<div style="font-size: 12px; padding: 4px 0;">${p.debtors?.company || 'Unknown'}: ${p.summary || ''}</div>`
    })
    html += `</div>`
  }
 
  // Inbound replies
  if (inboundReplies.length > 0) {
    html += `<div style="margin-bottom: 16px;">
      <div style="font-weight: 700; font-size: 13px; margin-bottom: 8px; color: #111;">↙️ Inbound Replies</div>`
    inboundReplies.forEach(r => {
      html += `<div style="font-size: 12px; padding: 4px 0;">${r.channel.toUpperCase()} from ${r.debtors?.company || 'Unknown'}: ${(r.summary || '').substring(0, 100)}</div>`
    })
    html += `</div>`
  }
 
  // Tomorrow's preview
  if (activeDebtors && activeDebtors.length > 0) {
    html += `<div style="margin-bottom: 16px; border-top: 1px solid #e5e7eb; padding-top: 12px;">
      <div style="font-weight: 700; font-size: 13px; margin-bottom: 8px; color: #111;">📋 Tomorrow's Queue (${activeDebtors.length} active)</div>`
    activeDebtors.slice(0, 10).forEach(d => {
      html += `<div style="font-size: 12px; padding: 3px 0; color: #555;">${d.company} (${d.name}) - ${d.next_action}</div>`
    })
    if (activeDebtors.length > 10) {
      html += `<div style="font-size: 11px; color: #999; margin-top: 4px;">...and ${activeDebtors.length - 10} more</div>`
    }
    html += `</div>`
  }
 
  html += `
        <div style="font-size: 10px; color: #999; margin-top: 16px; border-top: 1px solid #e5e7eb; padding-top: 12px;">
          Ashveil by Zenith Legal Services Group Ltd
        </div>
      </div>
    </div>`
 
  // Send via SendGrid
  const sgResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: (process.env.DIRECTOR_EMAIL || 'ja@zenithlegalgroup.com,hc@zenithlegalgroup.com').split(',').map(e => ({ email: e.trim() })) }],
      from: { email: process.env.SENDGRID_FROM_EMAIL || 'settlements@zenithlegalgroup.com', name: 'Ashveil' },
      subject: `Ashveil Daily Summary - ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} - ${calls.length} calls, £${totalRecovered.toLocaleString('en-GB')} recovered`,
      content: [{ type: 'text/html', value: html }],
    }),
  })
 
  if (!sgResponse.ok) {
    console.error('Daily email failed:', await sgResponse.text())
  }
}
 
