import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// Sequence definitions - must match frontend
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
    // 'letter' and 'legal' are manual - we just log them as needing attention
    return true
  } catch (err) {
    console.error(`Failed to fire ${step.channel} for debtor ${debtorId}:`, err)
    return false
  }
}

export async function GET(request) {
  // Simple auth - check for a secret key to prevent random hits
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServerClient()
  const results = { processed: 0, fired: 0, skipped: 0, errors: 0, manual_required: [], details: [] }

  // Get all active debtors that aren't paused or settled
  const { data: debtors, error } = await supabase
    .from('debtors')
    .select('*')
    .in('status', ['queued', 'active'])
    .eq('sequence_paused', false)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const now = new Date()
  // Working hours check - 9am to 6pm Mon-Fri UK time
  const ukHour = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' })).getHours()
  const ukDay = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' })).getDay()

  if (ukHour < 9 || ukHour >= 18 || ukDay === 0 || ukDay === 6) {
    return NextResponse.json({ message: 'Outside working hours (09:00-18:00 Mon-Fri UK)', skipped: true })
  }

  for (const debtor of debtors) {
    results.processed++

    // Calculate sequence day from when sequence started
    const startDate = debtor.sequence_started_at ? new Date(debtor.sequence_started_at) : new Date(debtor.created_at)
    const daysSinceStart = Math.floor((now - startDate) / 86400000)
    const currentDay = daysSinceStart + 1 // Day 1 is the first day

    // Get the sequence for this debtor's priority
    const sequence = SEQUENCES[debtor.priority] || SEQUENCES.medium

    // Find steps that should fire today
    const todaysSteps = sequence.filter(step => step.day === currentDay)

    if (todaysSteps.length === 0) {
      results.skipped++
      continue
    }

    // Check which steps have already been fired (check timeline)
    const { data: existingTimeline } = await supabase
      .from('timeline')
      .select('channel, sequence_day')
      .eq('debtor_id', debtor.id)
      .eq('sequence_day', currentDay)

    const firedChannels = new Set((existingTimeline || []).map(t => t.channel))

    for (const step of todaysSteps) {
      // Skip if already fired today
      if (firedChannels.has(step.channel)) {
        results.skipped++
        continue
      }

      // Manual steps - flag for human attention
      if (!step.auto) {
        results.manual_required.push({
          debtor_id: debtor.id,
          company: debtor.company,
          name: debtor.name,
          day: currentDay,
          channel: step.channel,
          action: step.channel === 'letter' ? 'Post pre-action letter' : 'Escalate to legal review',
        })

        // Log as pending in timeline
        await supabase.from('timeline').insert({
          debtor_id: debtor.id,
          sequence_day: currentDay,
          channel: step.channel,
          direction: 'out',
          status: 'pending',
          summary: `MANUAL ACTION REQUIRED: ${step.channel} on day ${currentDay}`,
          metadata: { auto: false },
        })
        continue
      }

      // Fire the automated action
      const success = await fireAction(step, debtor.id)

      if (success) {
        results.fired++
        results.details.push({
          debtor: debtor.company,
          day: currentDay,
          channel: step.channel,
          status: 'fired',
        })
      } else {
        results.errors++
        results.details.push({
          debtor: debtor.company,
          day: currentDay,
          channel: step.channel,
          status: 'error',
        })
      }
    }

    // Update debtor sequence day and status
    await supabase.from('debtors').update({
      sequence_day: currentDay,
      status: currentDay === 1 && debtor.status === 'queued' ? 'active' : debtor.status,
      sequence_started_at: debtor.sequence_started_at || now.toISOString(),
      next_action: getNextAction(sequence, currentDay),
    }).eq('id', debtor.id)
  }

  return NextResponse.json({
    success: true,
    timestamp: now.toISOString(),
    ...results,
  })
}

function getNextAction(sequence, currentDay) {
  const future = sequence.filter(s => s.day > currentDay).sort((a, b) => a.day - b.day)
  if (future.length === 0) return 'Sequence complete'
  const next = future[0]
  const channelLabels = { email: 'Email', sms: 'SMS', call: 'AI Call', whatsapp: 'WhatsApp', letter: 'Letter', payment: 'Stripe link', legal: 'Legal review' }
  return `Day ${next.day}: ${channelLabels[next.channel] || next.channel}`
}
