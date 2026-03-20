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

    // Format amount naturally for speech
    const amountWhole = Math.floor(amount)
    const amountSpoken = amountWhole >= 1000
      ? `${Math.floor(amountWhole/1000)} thousand ${amountWhole % 1000 > 0 ? 'and ' + (amountWhole % 1000) : ''} pounds`
      : `${amountWhole} pounds`

    // Core instructions for all tones
    const coreInstructions = `
CRITICAL SPEECH RULES:
- NEVER read numbers digit by digit. Say "five thousand and seventy five pounds" not "five zero seven five point zero zero".
- NEVER say "point zero zero" or read decimal places for whole amounts.
- Be conversational and natural. You are a human collections agent, not a robot.
- Use short sentences. Pause naturally.
- If they ask who you are: "I'm calling from Zenith Legal Services regarding an outstanding matter."
- If they get aggressive or threaten you: stay calm, say "I understand this is difficult, but we do need to resolve this matter" and continue.
- If they say they have a solicitor: say "That's fine, please have your solicitor contact us at settlements@zenithlegalgroup.com" and end the call politely.
- If they say they are vulnerable or have a disability: say "I understand, I'll make a note and have someone from our team contact you directly to discuss your circumstances" and end the call politely.
- If they request a callback: confirm the date and time, and say you'll arrange that.

AT THE END OF EVERY CALL, you must clearly state the outcome by saying one of these exact phrases:
- "OUTCOME: PAYMENT_AGREED" if they agreed to pay or set up a payment plan
- "OUTCOME: CALLBACK_REQUESTED [date/time]" if they asked for a callback (include when)
- "OUTCOME: DISPUTED" if they dispute the debt
- "OUTCOME: REFUSED" if they refused to engage
- "OUTCOME: VOICEMAIL" if you reached voicemail
- "OUTCOME: NO_ANSWER" if nobody picked up
- "OUTCOME: VULNERABLE" if they indicated vulnerability
- "OUTCOME: SOLICITOR" if they referenced a solicitor
Say this outcome phrase right before your final goodbye. The debtor won't notice it but our system needs it.

The outstanding amount is ${amountSpoken}. The debtor's name is ${debtor.name}. The company is ${debtor.company}.
${assetContext}
`

    // Tone-specific instructions
    const tones = {
      professional: `You are calling on behalf of Zenith Legal Services regarding an outstanding sum of ${amountSpoken} relating to ${debtor.company}. Be professional and courteous but clear that payment is required. Offer to discuss payment arrangements. If they can't pay in full, suggest instalments. ${coreInstructions}`,
      firm: `You are calling on behalf of Zenith Legal Services regarding an overdue payment of ${amountSpoken} for ${debtor.company}. Previous correspondence has gone unanswered. Be direct and firm. Make clear that failure to engage will result in escalation. Do not be rude but do not be soft. ${flagContext} ${coreInstructions}`,
      final: `This is a final call from Zenith Legal Services regarding ${amountSpoken} outstanding for ${debtor.company}. Make clear that legal proceedings are being prepared and this is the last opportunity to settle or propose terms before escalation. Be serious and direct. ${flagContext} ${coreInstructions}`,
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
        phoneNumberId: (() => { const ids = (process.env.VAPI_PHONE_NUMBER_IDS || process.env.VAPI_PHONE_NUMBER_ID || '').split(',').filter(Boolean); return ids[Math.floor(Math.random() * ids.length)]; })(),
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
            voiceId: process.env.VAPI_VOICE_ID || 'onwK4e9ZLuTAKqWW03F9',
          },
          recordingEnabled: true,
          firstMessage: `Hello, am I speaking with ${debtor.name}?`,
          endCallMessage: 'Thank you for your time. Goodbye.',
          maxDurationSeconds: 300,
          silenceTimeoutSeconds: 15,
          endCallPhrases: ['I want to speak to a solicitor', 'I am going to kill', 'I am vulnerable', 'I have a disability'],
          serverUrl: `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/vapi`,
          metadata: {
            debtor_id: debtor.id,
            company: debtor.company,
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
