import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createServerClient } from '@/lib/supabase'

const getStripe = () => new Stripe(process.env.STRIPE_SECRET_KEY)

export async function POST(request) {
  const body = await request.text()
  const sig = request.headers.get('stripe-signature')
  const stripe = getStripe()

  let event
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const supabase = createServerClient()

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const debtorId = session.metadata?.debtor_id

    if (debtorId) {
      const amountPaid = session.amount_total / 100

      // Record payment
      await supabase.from('payments').insert({
        debtor_id: debtorId,
        amount: amountPaid,
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: session.payment_intent,
        status: 'succeeded',
        received_at: new Date().toISOString(),
      })

      // Update debtor payments total
      const { data: debtor } = await supabase
        .from('debtors')
        .select('payments, base_amount, principal, type')
        .eq('id', debtorId)
        .single()

      if (debtor) {
        const newTotal = parseFloat(debtor.payments) + amountPaid
        const totalOwed = debtor.type === 'cvl' ? debtor.base_amount : debtor.principal
        const isSettled = newTotal >= totalOwed

        await supabase.from('debtors').update({
          payments: newTotal,
          status: isSettled ? 'settled' : 'payment_plan',
          sequence_paused: true, // Pause sequence on payment
          next_action: isSettled ? 'Settled' : `Partial payment received (${amountPaid.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })})`,
        }).eq('id', debtorId)

        // Log to timeline
        await supabase.from('timeline').insert({
          debtor_id: debtorId,
          channel: 'payment',
          direction: 'in',
          status: 'sent',
          result: isSettled ? 'paid_full' : 'partial_paid',
          summary: `Payment received: ${amountPaid.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })}${isSettled ? ' - SETTLED IN FULL' : ''}`,
          metadata: { amount: amountPaid, session_id: session.id },
          executed_at: new Date().toISOString(),
        })
      }
    }
  }

  return NextResponse.json({ received: true })
}

// Disable body parsing so we can verify the webhook signature
