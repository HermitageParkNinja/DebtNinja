import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export async function POST(request) {
  try {
    const body = await request.json()
    const supabase = createServerClient()

    const eventType = body.message?.type || body.type
    const call = body.message?.call || body.call || {}
    const metadata = call.assistant?.metadata || call.metadata || {}
    const debtorId = metadata.debtor_id

    if (!debtorId) {
      // Not one of our calls or missing metadata
      return NextResponse.json({ received: true })
    }

    // ── Call ended - main event we care about ──
    if (eventType === 'end-of-call-report' || eventType === 'call.ended') {
      const transcript = body.message?.transcript || body.transcript || ''
      const recordingUrl = body.message?.recordingUrl || body.recordingUrl || call.recordingUrl || ''
      const duration = body.message?.duration || body.duration || call.duration || 0
      const summary = body.message?.summary || body.summary || ''

      // Parse outcome from transcript
      let outcome = 'completed'
      let callbackDate = null
      const transcriptText = typeof transcript === 'string' ? transcript : JSON.stringify(transcript)

      if (transcriptText.includes('OUTCOME: PAYMENT_AGREED')) outcome = 'payment_agreed'
      else if (transcriptText.includes('OUTCOME: CALLBACK_REQUESTED')) {
        outcome = 'callback_requested'
        // Try to extract the callback time
        const match = transcriptText.match(/OUTCOME: CALLBACK_REQUESTED\s*\[?([^\]]*)\]?/)
        if (match) callbackDate = match[1].trim()
      }
      else if (transcriptText.includes('OUTCOME: DISPUTED')) outcome = 'disputed'
      else if (transcriptText.includes('OUTCOME: REFUSED')) outcome = 'refused'
      else if (transcriptText.includes('OUTCOME: VOICEMAIL')) outcome = 'voicemail'
      else if (transcriptText.includes('OUTCOME: NO_ANSWER')) outcome = 'no_answer'
      else if (transcriptText.includes('OUTCOME: VULNERABLE')) outcome = 'vulnerable'
      else if (transcriptText.includes('OUTCOME: SOLICITOR')) outcome = 'solicitor'

      // Clean transcript - remove the OUTCOME line for display
      const cleanTranscript = transcriptText.replace(/OUTCOME:.*$/gm, '').trim()

      // Build summary based on outcome
      const outcomeSummaries = {
        payment_agreed: 'Debtor agreed to payment arrangement',
        callback_requested: `Debtor requested callback${callbackDate ? ': ' + callbackDate : ''}`,
        disputed: 'Debtor disputes the debt - HUMAN REVIEW REQUIRED',
        refused: 'Debtor refused to engage',
        voicemail: 'Voicemail left',
        no_answer: 'No answer',
        vulnerable: 'VULNERABLE DEBTOR FLAGGED - sequence paused - HUMAN REVIEW REQUIRED',
        solicitor: 'Debtor referenced solicitor - details provided - HUMAN REVIEW REQUIRED',
        completed: 'Call completed',
      }

      // Log to timeline
      await supabase.from('timeline').insert({
        debtor_id: debtorId,
        channel: 'call',
        direction: 'out',
        status: 'sent',
        result: outcome,
        summary: outcomeSummaries[outcome] || 'Call completed',
        transcript: cleanTranscript.substring(0, 10000), // Limit transcript length
        metadata: {
          call_id: call.id,
          recording_url: recordingUrl,
          duration_seconds: duration,
          outcome,
          callback_date: callbackDate,
          vapi_summary: summary,
        },
        executed_at: new Date().toISOString(),
      })

      // Update debtor based on outcome
      const updates = { last_contact: new Date().toISOString() }

      if (outcome === 'payment_agreed') {
        updates.status = 'negotiating'
        updates.next_action = 'Payment arrangement agreed - generating Stripe link'

        // Auto-generate payment link and send via SMS
        try {
          // Generate a standard payment link first
          const stripeRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/stripe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ debtor_id: debtorId }),
          })
          const stripeData = await stripeRes.json()

          if (stripeData.payment_link) {
            // Send the link via SMS immediately
            await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/sms`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                debtor_id: debtorId,
                channel: 'sms',
                custom_message: `Following our conversation, here is your secure payment link as agreed: ${stripeData.payment_link} - Zenith Legal Services`,
              }),
            })
            updates.next_action = 'Payment link sent via SMS after call'
          }
        } catch (e) {
          console.error('Auto payment link failed:', e)
        }
      } else if (outcome === 'callback_requested') {
        updates.next_action = `Callback requested${callbackDate ? ': ' + callbackDate : ''}`
        // Schedule the callback in timeline
        if (callbackDate) {
          await supabase.from('timeline').insert({
            debtor_id: debtorId,
            channel: 'call',
            direction: 'out',
            status: 'scheduled',
            summary: `Scheduled callback: ${callbackDate}`,
            metadata: { callback_date: callbackDate, auto_scheduled: true },
          })
        }
      } else if (outcome === 'disputed') {
        updates.status = 'disputed'
        updates.sequence_paused = true
        updates.next_action = 'DISPUTED - human review required'
      } else if (outcome === 'vulnerable') {
        updates.sequence_paused = true
        updates.next_action = 'VULNERABLE - human review required'
      } else if (outcome === 'solicitor') {
        updates.next_action = 'Solicitor referenced - review correspondence'
      } else if (outcome === 'voicemail') {
        updates.next_action = 'Voicemail left - await response'
      } else if (outcome === 'refused') {
        updates.next_action = 'Refused to engage - continue sequence'
      }

      await supabase.from('debtors').update(updates).eq('id', debtorId)
    }

    // ── Status updates during call ──
    if (eventType === 'status-update' || eventType === 'call.status') {
      const status = body.message?.status || body.status
      if (status === 'ringing' || status === 'in-progress') {
        await supabase.from('debtors').update({
          last_contact: new Date().toISOString(),
        }).eq('id', debtorId)
      }
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('Vapi webhook error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
