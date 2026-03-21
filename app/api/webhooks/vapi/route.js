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

      let agreedAmount = null

   // Normalise transcript for matching - TTS outputs commas not colons
      const normalised = transcriptText.toLowerCase().replace(/,/g, '').replace(/:/g, '')

      if (normalised.includes('outcome payment full') || normalised.includes('outcome payment_full')) {
        outcome = 'payment_full'
        const match = transcriptText.match(/[Oo]utcome[,:.]?\s*[Pp]ayment.?[Ff]ull[,:.]?\s*(\d[\d.,\s]*)/i)
        if (match) agreedAmount = parseFloat(match[1].replace(/[,\s]/g, ''))
      }
      else if (normalised.includes('outcome payment plan') || normalised.includes('outcome payment_plan')) {
        outcome = 'payment_plan'
        const match = transcriptText.match(/[Oo]utcome[,:.]?\s*[Pp]ayment.?[Pp]lan[,:.]?\s*(\d[\d.,\s]*)/i)
        if (match) agreedAmount = parseFloat(match[1].replace(/[,\s]/g, ''))
      }
      else if (normalised.includes('outcome payment agreed') || normalised.includes('outcome payment_agreed')) {
        outcome = 'payment_agreed'
        const match = transcriptText.match(/[Oo]utcome[,:.]?\s*[Pp]ayment.?[Aa]greed\s*(\d[\d.,\s]*)?/i)
        if (match && match[1]) agreedAmount = parseFloat(match[1].replace(/[,\s]/g, ''))
      }
      else if (normalised.includes('outcome callback requested') || normalised.includes('outcome callback_requested')) {
        outcome = 'callback_requested'
        const match = transcriptText.match(/[Oo]utcome[,:.]?\s*[Cc]allback.?[Rr]equested\s*\[?([^\]\n]*)\]?/i)
        if (match) callbackDate = match[1].trim()
      }
      else if (normalised.includes('outcome disputed')) outcome = 'disputed'
      else if (normalised.includes('outcome refused')) outcome = 'refused'
      else if (normalised.includes('outcome voicemail')) outcome = 'voicemail'
      else if (normalised.includes('outcome no answer')) outcome = 'no_answer'
      else if (normalised.includes('outcome vulnerable')) outcome = 'vulnerable'
      else if (normalised.includes('outcome solicitor')) outcome = 'solicitor'

      // Clean transcript - remove the OUTCOME line for display
      const cleanTranscript = transcriptText.replace(/OUTCOME:.*$/gm, '').trim()

      // Build summary based on outcome
      const amountStr = agreedAmount ? `£${agreedAmount.toLocaleString('en-GB', { minimumFractionDigits: 2 })}` : ''
      const outcomeSummaries = {
        payment_full: `Debtor agreed to pay in full${amountStr ? ': ' + amountStr : ''}`,
        payment_plan: `Debtor agreed payment plan${amountStr ? ': ' + amountStr + '/month' : ''}`,
        payment_agreed: `Debtor agreed to payment${amountStr ? ': ' + amountStr : ''}`,
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
      const BASE_URL = process.env.NEXT_PUBLIC_APP_URL

      // Auto-create payment plan or full payment link
      async function autoSendPaymentLink(type, monthlyAmount, fullAmount) {
        try {
          let linkUrl = null

          if (type === 'plan' && monthlyAmount) {
            // Create instalment plan
            const planRes = await fetch(`${BASE_URL}/api/payment-plan`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ debtor_id: debtorId, monthly_amount: monthlyAmount }),
            })
            const planData = await planRes.json()
            linkUrl = planData.payment_link
          } else {
            // Full or settlement payment link - pass custom amount if it's a settlement
            const body = { debtor_id: debtorId }
            if (fullAmount) {
              body.custom_amount = fullAmount
              body.settlement = true
            }
            const stripeRes = await fetch(`${BASE_URL}/api/stripe`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            })
            const stripeData = await stripeRes.json()
            linkUrl = stripeData.payment_link
          }

          if (linkUrl) {
            let msg
            if (type === 'plan') {
              msg = `Following our conversation, here is your secure payment plan link for £${monthlyAmount}/month as agreed: ${linkUrl} - Zennith Legal Services`
            } else if (fullAmount) {
              msg = `Following our conversation, here is your secure payment link for the agreed settlement of £${fullAmount.toLocaleString('en-GB')} as discussed: ${linkUrl} - Zennith Legal Services`
            } else {
              msg = `Following our conversation, here is your secure payment link as agreed: ${linkUrl} - Zennith Legal Services`
            }

            // Send via SMS
            await fetch(`${BASE_URL}/api/sms`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ debtor_id: debtorId, channel: 'sms', custom_message: msg }),
            })

            // Also send via email
            await fetch(`${BASE_URL}/api/email`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ debtor_id: debtorId, template: 'payment_plan_confirmation' }),
            })

            return linkUrl
          }
        } catch (e) {
          console.error('Auto payment link failed:', e)
        }
        return null
      }

      if (outcome === 'payment_full') {
        updates.status = 'negotiating'
        // Check if the agreed amount is less than full - if so, it's a settlement
        let isSettlement = false
        if (agreedAmount) {
          const { data: dbt } = await supabase.from('debtors').select('base_amount, principal, daily_interest, invoice_date, type, payments').eq('id', debtorId).single()
          if (dbt) {
            let fullAmount
            if (dbt.type === 'cvl') { fullAmount = parseFloat(dbt.base_amount) - parseFloat(dbt.payments) }
            else { const days = Math.max(0, Math.floor((new Date() - new Date(dbt.invoice_date)) / 86400000)); fullAmount = parseFloat(dbt.principal) + (parseFloat(dbt.daily_interest) * days) - parseFloat(dbt.payments) }
            isSettlement = agreedAmount < fullAmount * 0.99
          }
        }
        if (isSettlement) {
          updates.next_action = `Settlement agreed: £${agreedAmount.toLocaleString('en-GB')} - generating Stripe link`
        } else {
          updates.next_action = 'Full payment agreed - generating Stripe link'
        }
        const link = await autoSendPaymentLink('full', null, agreedAmount || null)
        if (link) {
          updates.next_action = isSettlement
            ? `Settlement £${agreedAmount.toLocaleString('en-GB')} link sent via SMS and email`
            : 'Full payment link sent via SMS and email'
        }

      } else if (outcome === 'payment_plan' && agreedAmount) {
        updates.status = 'payment_plan'
        updates.next_action = `Plan agreed: £${agreedAmount}/month - generating Stripe link`
        updates.sequence_paused = true
        const link = await autoSendPaymentLink('plan', agreedAmount)
        if (link) updates.next_action = `£${agreedAmount}/month plan link sent via SMS and email`

      } else if (outcome === 'payment_agreed') {
        // Legacy or amount not extracted - generate standard link
        updates.status = 'negotiating'
        updates.next_action = 'Payment agreed - generating Stripe link'
        if (agreedAmount) {
          const link = await autoSendPaymentLink('plan', agreedAmount)
          if (link) updates.next_action = `£${agreedAmount}/month plan link sent via SMS and email`
        } else {
          const link = await autoSendPaymentLink('full')
          if (link) updates.next_action = 'Payment link sent via SMS and email'
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
