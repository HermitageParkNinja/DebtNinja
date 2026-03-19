import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

const VAPI_API = 'https://api.vapi.ai'

export async function POST(request) {
  try {
    const { debtor_id, tone } = await request.json()
    const supabase = createServerClient()

    const vapiKey = process.env.VAPI_API_KEY
    if (!vapiKey) {
      return NextResponse.json({ error: 'Vapi not configured. Add your API key in Settings.' }, { status: 400 })
    }

    const { data: debtor, error } = await supabase
      .from('debtors')
      .select('*, intelligence(claims, assets, flags)')
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

    // Build intelligence context for the AI
    const intel = debtor.intelligence?.[0]
    const assetContext = intel?.assets?.length ? `Known assets: ${intel.assets.join(', ')}.` : 'No known assets.'
    const flagContext = intel?.flags?.length ? `Flags: ${intel.flags.join(', ')}.` : ''

    // Phone number formatting
    let phoneNumber = debtor.phone.replace(/\s/g, '')
    if (phoneNumber.startsWith('0')) phoneNumber = '+44' + phoneNumber.slice(1)
    if (!phoneNumber.startsWith('+')) phoneNumber = '+44' + phoneNumber

    // Tone-specific instructions
    const tones = {
      professional: `You are calling on behalf of Zenith Legal Services regarding an outstanding debt of ${amountStr} relating to ${debtor.company}. Be professional and courteous but clear that payment is required. Offer to discuss payment arrangements. ${assetContext}`,
      firm: `You are calling on behalf of Zenith Legal Services regarding an overdue payment of ${amountStr} for ${debtor.company}. Previous correspondence has gone unanswered. Be direct and firm. Make clear that failure to engage will result in escalation. ${assetContext} ${flagContext}`,
      final: `This is a final call from Zenith Legal Services regarding ${amountStr} outstanding for ${debtor.company}. Make clear that legal proceedings are being prepared and this is the last opportunity to settle or propose terms before escalation. ${assetContext} ${flagContext}`,
    }

    const systemMessage = tones[tone] || tones.professional

    // Create Vapi call
    const vapiResponse = await fetch(`${VAPI_API}/call/phone`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${vapiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID || undefined,
        customer: {
          number: phoneNumber,
          name: debtor.name,
        },
        assistant: {
          model: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            messages: [{ role: 'system', content: systemMessage }],
          },
          voice: {
            provider: '11labs',
            voiceId: process.env.VAPI_VOICE_ID || 'pNInz6obpgDQGcFmaJgB', // Default British male
          },
          firstMessage: `Hello, am I speaking with ${debtor.name}?`,
          endCallMessage: 'Thank you for your time. Goodbye.',
          maxDurationSeconds: 180,
          silenceTimeoutSeconds: 15,
          // Escalation triggers - hand off to human
          endCallPhrases: ['I want to speak to a solicitor', 'I am going to kill', 'I am vulnerable', 'I have a disability'],
          metadata: {
            debtor_id: debtor.id,
            company: debtor.company,
            amount: amountStr,
          },
        },
      }),
    })

    if (!vapiResponse.ok) {
      const vapiError = await vapiResponse.text()
      console.error('Vapi error:', vapiError)
      return NextResponse.json({ error: 'AI call failed: ' + vapiError }, { status: 500 })
    }

    const callData = await vapiResponse.json()

    // Log to timeline
    await supabase.from('timeline').insert({
      debtor_id,
      channel: 'call',
      direction: 'out',
      status: 'sent',
      result: 'initiated',
      summary: `AI call initiated to ${debtor.phone} (${tone || 'professional'} tone)`,
      metadata: { call_id: callData.id, tone: tone || 'professional' },
      executed_at: new Date().toISOString(),
    })

    // Update debtor
    await supabase.from('debtors').update({
      last_contact: new Date().toISOString(),
    }).eq('id', debtor_id)

    return NextResponse.json({ success: true, call_id: callData.id })
  } catch (error) {
    console.error('Vapi call error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
