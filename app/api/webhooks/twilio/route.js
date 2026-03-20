import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export async function POST(request) {
  try {
    const formData = await request.formData()
    const from = formData.get('From') || ''
    const body = formData.get('Body') || ''
    const messageSid = formData.get('MessageSid') || ''
    const to = formData.get('To') || ''
    const numMedia = formData.get('NumMedia') || '0'

    const supabase = createServerClient()

    // Determine channel - WhatsApp prefixes with 'whatsapp:'
    const isWhatsApp = from.startsWith('whatsapp:')
    const channel = isWhatsApp ? 'whatsapp' : 'sms'
    const cleanFrom = from.replace('whatsapp:', '').replace(/\s/g, '')

    // Normalise the phone number for matching
    let searchNumber = cleanFrom
    if (searchNumber.startsWith('+44')) searchNumber = '0' + searchNumber.slice(3)

    // Find the debtor by phone number
    const { data: debtors } = await supabase
      .from('debtors')
      .select('id, name, company, phone, status')
      .or(`phone.ilike.%${searchNumber.slice(-10)}%,phone.ilike.%${cleanFrom.slice(-10)}%`)

    const debtor = debtors?.[0]

    if (debtor) {
      // Log inbound message to timeline
      await supabase.from('timeline').insert({
        debtor_id: debtor.id,
        channel,
        direction: 'in',
        status: 'sent',
        result: 'replied',
        summary: body.substring(0, 500),
        metadata: {
          message_sid: messageSid,
          from: cleanFrom,
          to,
          num_media: numMedia,
          full_body: body,
        },
        executed_at: new Date().toISOString(),
      })

      // Update debtor status
      const updates = {
        last_contact: new Date().toISOString(),
      }

      // If debtor was in active sequence, mark as responding
      if (['active', 'queued'].includes(debtor.status)) {
        updates.status = 'responding'
        updates.next_action = `Replied via ${channel.toUpperCase()}: "${body.substring(0, 60)}..."`
      }

      await supabase.from('debtors').update(updates).eq('id', debtor.id)

      // Auto-analyse the reply for intent
      // Simple keyword detection for now
      const lowerBody = body.toLowerCase()
      if (lowerBody.includes('pay') || lowerBody.includes('arrange') || lowerBody.includes('instalment') || lowerBody.includes('monthly')) {
        await supabase.from('timeline').insert({
          debtor_id: debtor.id,
          channel: 'system',
          direction: 'in',
          status: 'sent',
          result: 'payment_intent_detected',
          summary: `AI detected payment intent in ${channel.toUpperCase()} reply. Consider generating payment link.`,
          executed_at: new Date().toISOString(),
        })
      }

      if (lowerBody.includes('dispute') || lowerBody.includes('disagree') || lowerBody.includes('wrong') || lowerBody.includes('solicitor') || lowerBody.includes('lawyer')) {
        await supabase.from('debtors').update({
          status: 'disputed',
          sequence_paused: true,
          next_action: 'DISPUTED via ' + channel.toUpperCase() + ' - human review required',
        }).eq('id', debtor.id)

        await supabase.from('timeline').insert({
          debtor_id: debtor.id,
          channel: 'system',
          direction: 'in',
          status: 'sent',
          result: 'dispute_detected',
          summary: `DISPUTE DETECTED in ${channel.toUpperCase()} reply. Sequence paused. Human review required.`,
          executed_at: new Date().toISOString(),
        })
      }

      if (lowerBody.includes('stop') || lowerBody.includes('unsubscribe') || lowerBody.includes('do not contact') || lowerBody.includes('leave me alone')) {
        await supabase.from('debtors').update({
          sequence_paused: true,
          next_action: 'STOP requested - comms paused - human review',
        }).eq('id', debtor.id)
      }
    } else {
      // Unknown sender - log it anyway
      console.log('Inbound message from unknown number:', cleanFrom, body)
    }

    // Twilio expects TwiML response
    return new NextResponse(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      { headers: { 'Content-Type': 'text/xml' } }
    )
  } catch (error) {
    console.error('Twilio inbound error:', error)
    return new NextResponse(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      { headers: { 'Content-Type': 'text/xml' } }
    )
  }
}
