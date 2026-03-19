import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

const TWILIO_API = 'https://api.twilio.com/2010-04-01'

async function sendTwilio(accountSid, authToken, from, to, body) {
  const url = `${TWILIO_API}/Accounts/${accountSid}/Messages.json`
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64')

  const params = new URLSearchParams()
  params.append('From', from)
  params.append('To', to)
  params.append('Body', body)

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.message || 'Twilio send failed')
  return data
}

// Pick a random number from the pool
function pickNumber() {
  const pool = (process.env.TWILIO_PHONE_NUMBERS || process.env.TWILIO_PHONE_NUMBER || '').split(',').map(n => n.trim()).filter(Boolean)
  if (pool.length === 0) throw new Error('No Twilio phone numbers configured')
  return pool[Math.floor(Math.random() * pool.length)]
}

export async function POST(request) {
  try {
    const { debtor_id, channel, template, custom_message } = await request.json()
    const supabase = createServerClient()

    const accountSid = process.env.TWILIO_ACCOUNT_SID
    const authToken = process.env.TWILIO_AUTH_TOKEN

    if (!accountSid || !authToken) {
      return NextResponse.json({ error: 'Twilio not configured. Add API keys in Settings.' }, { status: 400 })
    }

    const { data: debtor, error } = await supabase
      .from('debtors')
      .select('*')
      .eq('id', debtor_id)
      .single()

    if (error || !debtor) {
      return NextResponse.json({ error: 'Debtor not found' }, { status: 404 })
    }

    if (!debtor.phone) {
      return NextResponse.json({ error: 'Debtor has no phone number' }, { status: 400 })
    }

    // Calculate amount
    let amount
    if (debtor.type === 'cvl') {
      amount = parseFloat(debtor.base_amount) - parseFloat(debtor.payments)
    } else {
      const now = new Date()
      const invDate = new Date(debtor.invoice_date)
      const days = Math.max(0, Math.floor((now - invDate) / 86400000))
      amount = parseFloat(debtor.principal) + (parseFloat(debtor.daily_interest) * days) - parseFloat(debtor.payments)
    }

    const amountStr = amount.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })
    const paymentLink = debtor.stripe_payment_link_url || ''

    // SMS templates
    const templates = {
      initial_chase: `${debtor.name}, we have written to you regarding ${amountStr} owed in relation to ${debtor.company}. Please review and respond.${paymentLink ? ' Pay here: ' + paymentLink : ''} - Zenith Legal`,
      payment_reminder: `${debtor.name}, your payment of ${amountStr} relating to ${debtor.company} is overdue.${paymentLink ? ' Pay now: ' + paymentLink : ''} - Zenith Legal`,
      urgent: `URGENT: ${amountStr} remains outstanding for ${debtor.company}. Failure to engage may result in escalation.${paymentLink ? ' Settle now: ' + paymentLink : ''} - Zenith Legal`,
      final: `FINAL NOTICE: ${amountStr} for ${debtor.company}. Without payment within 48hrs we will proceed without further notice.${paymentLink ? ' ' + paymentLink : ''} - Zenith Legal`,
    }

    const body = custom_message || templates[template] || templates.initial_chase

    // Determine from number and prefix
    const fromNumber = pickNumber()
    let to = debtor.phone.replace(/\s/g, '')
    if (to.startsWith('0')) to = '+44' + to.slice(1)
    if (!to.startsWith('+')) to = '+44' + to

    let from = fromNumber
    let msgChannel = channel || 'sms'

    // WhatsApp prefix
    if (msgChannel === 'whatsapp') {
      from = `whatsapp:${fromNumber}`
      to = `whatsapp:${to}`
    }

    const result = await sendTwilio(accountSid, authToken, from, to, body)

    // Log to timeline
    await supabase.from('timeline').insert({
      debtor_id,
      channel: msgChannel,
      direction: 'out',
      status: 'sent',
      result: 'delivered',
      summary: `${msgChannel.toUpperCase()} sent to ${debtor.phone}: ${body.substring(0, 80)}...`,
      metadata: { sid: result.sid, from: fromNumber, template: template || 'custom' },
      executed_at: new Date().toISOString(),
    })

    // Update debtor
    await supabase.from('debtors').update({
      last_contact: new Date().toISOString(),
    }).eq('id', debtor_id)

    return NextResponse.json({ success: true, sid: result.sid, from: fromNumber })
  } catch (error) {
    console.error('SMS/WhatsApp error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
