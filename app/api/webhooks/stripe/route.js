import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createServerClient } from '@/lib/supabase'

const getStripe = () => new Stripe(process.env.STRIPE_SECRET_KEY)

async function processPayment(supabase, stripe, debtorId, amountPaid, metadata) {
  // Record payment
  await supabase.from('payments').insert({
    debtor_id: debtorId,
    amount: amountPaid,
    stripe_payment_intent_id: metadata.payment_intent || null,
    stripe_checkout_session_id: metadata.session_id || null,
    status: 'succeeded',
    received_at: new Date().toISOString(),
  })

  // Get debtor with current totals
  const { data: debtor } = await supabase
    .from('debtors')
    .select('payments, base_amount, principal, daily_interest, invoice_date, type')
    .eq('id', debtorId)
    .single()

  if (!debtor) return

  const newTotalPaid = parseFloat(debtor.payments) + amountPaid

  // Calculate total owed (including interest for commercial)
  let totalOwed
  if (debtor.type === 'cvl') {
    totalOwed = parseFloat(debtor.base_amount)
  } else {
    const now = new Date()
    const invDate = new Date(debtor.invoice_date)
    const days = Math.max(0, Math.floor((now - invDate) / 86400000))
    totalOwed = parseFloat(debtor.principal) + (parseFloat(debtor.daily_interest) * days)
  }

  const remaining = totalOwed - newTotalPaid
  const isSettlement = metadata.settlement === 'true'
  const isSettled = remaining <= 0.50 || isSettlement // Settlement = full and final regardless of remaining

  const amountStr = amountPaid.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })
  const remainStr = Math.max(0, remaining).toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })

  // Update debtor
  await supabase.from('debtors').update({
    payments: newTotalPaid,
    status: isSettled ? 'settled' : 'payment_plan',
    sequence_paused: true,
    next_action: isSettled ? (isSettlement ? 'SETTLED - Full and final settlement accepted' : 'SETTLED IN FULL') : `${remainStr} remaining`,
    last_contact: new Date().toISOString(),
  }).eq('id', debtorId)

  // Log to timeline
  await supabase.from('timeline').insert({
    debtor_id: debtorId,
    channel: 'payment',
    direction: 'in',
    status: 'sent',
    result: isSettled ? 'paid_full' : 'partial_paid',
    summary: isSettled
      ? (isSettlement ? `SETTLEMENT ACCEPTED - ${amountStr} full and final` : `SETTLED IN FULL - Final payment of ${amountStr} received`)
      : `Payment received: ${amountStr} (${remainStr} remaining)`,
    metadata: { amount: amountPaid, total_paid: newTotalPaid, remaining, ...metadata },
    executed_at: new Date().toISOString(),
  })

  // If settled, cancel any active subscription
  if (isSettled && metadata.subscription_id) {
    try {
      await stripe.subscriptions.cancel(metadata.subscription_id)
      await supabase.from('timeline').insert({
        debtor_id: debtorId,
        channel: 'payment',
        direction: 'out',
        status: 'sent',
        result: 'subscription_cancelled',
        summary: 'Payment plan subscription cancelled - debt settled in full',
        executed_at: new Date().toISOString(),
      })
    } catch (e) {
      console.error('Failed to cancel subscription:', e)
    }
  }

  // If next instalment would overpay, update the subscription price
  if (!isSettled && remaining > 0 && metadata.subscription_id) {
    const subscriptionId = metadata.subscription_id
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId)
      const currentItemId = sub.items?.data?.[0]?.id
      const currentAmount = sub.items?.data?.[0]?.price?.unit_amount / 100

      // If remaining is less than one full instalment, adjust
      if (remaining < currentAmount && remaining > 0) {
        // Create new price for the final amount
        const finalPrice = await stripe.prices.create({
          currency: 'gbp',
          unit_amount: Math.round(remaining * 100),
          recurring: { interval: 'month' },
          product: sub.items.data[0].price.product,
        })

        // Update the subscription to the final amount
        await stripe.subscriptions.update(subscriptionId, {
          items: [{ id: currentItemId, price: finalPrice.id }],
        })

        await supabase.from('timeline').insert({
          debtor_id: debtorId,
          channel: 'system',
          direction: 'out',
          status: 'sent',
          result: 'plan_adjusted',
          summary: `Final instalment adjusted to ${remaining.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })} (remaining balance)`,
          executed_at: new Date().toISOString(),
        })
      }
    } catch (e) {
      console.error('Failed to adjust subscription:', e)
    }
  }
}

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

  // ── One-off payment completed ──
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const debtorId = session.metadata?.debtor_id

    if (debtorId && session.amount_total) {
      await processPayment(supabase, stripe, debtorId, session.amount_total / 100, {
        payment_intent: session.payment_intent,
        session_id: session.id,
        subscription_id: session.subscription || null,
        settlement: session.metadata?.settlement || 'false',
      })
    }
  }

  // ── Recurring subscription payment succeeded ──
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object

    // Only process subscription invoices (not one-off)
    if (invoice.subscription) {
      // Get debtor_id from subscription metadata
      let debtorId = invoice.subscription_details?.metadata?.debtor_id

      // If not in invoice metadata, look up the subscription
      if (!debtorId) {
        try {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription)
          debtorId = sub.metadata?.debtor_id
        } catch (e) {
          console.error('Failed to retrieve subscription:', e)
        }
      }

      if (debtorId && invoice.amount_paid) {
        await processPayment(supabase, stripe, debtorId, invoice.amount_paid / 100, {
          payment_intent: invoice.payment_intent,
          invoice_id: invoice.id,
          subscription_id: invoice.subscription,
        })
      }
    }
  }

  return NextResponse.json({ received: true })
}
