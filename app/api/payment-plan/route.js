import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

const getStripe = () => {
  const Stripe = require('stripe')
  return new Stripe(process.env.STRIPE_SECRET_KEY)
}

export async function POST(request) {
  try {
    const { debtor_id, monthly_amount, num_months } = await request.json()
    const stripe = getStripe()
    const supabase = createServerClient()

    const { data: debtor, error } = await supabase
      .from('debtors')
      .select('*')
      .eq('id', debtor_id)
      .single()

    if (error || !debtor) {
      return NextResponse.json({ error: 'Debtor not found' }, { status: 404 })
    }

    // Calculate total owed
    let totalOwed
    if (debtor.type === 'cvl') {
      totalOwed = parseFloat(debtor.base_amount) - parseFloat(debtor.payments)
    } else {
      const now = new Date()
      const invDate = new Date(debtor.invoice_date)
      const days = Math.max(0, Math.floor((now - invDate) / 86400000))
      totalOwed = parseFloat(debtor.principal) + (parseFloat(debtor.daily_interest) * days) - parseFloat(debtor.payments)
    }

    if (totalOwed <= 0) {
      return NextResponse.json({ error: 'No amount outstanding' }, { status: 400 })
    }

    // If monthly amount specified, calculate number of months
    const monthlyPence = Math.round((monthly_amount || Math.ceil(totalOwed / (num_months || 3))) * 100)
    const months = num_months || Math.ceil(totalOwed / (monthly_amount || totalOwed))

    // Create a Stripe product for this debtor
    const product = await stripe.products.create({
      name: `Payment Plan - ${debtor.company}`,
      metadata: { debtor_id: debtor.id, company: debtor.company },
    })

    // Create a recurring price
    const price = await stripe.prices.create({
      product: product.id,
      currency: 'gbp',
      unit_amount: monthlyPence,
      recurring: { interval: 'month' },
      metadata: { debtor_id: debtor.id },
    })

    // Create a payment link with the subscription
    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: {
        debtor_id: debtor.id,
        plan_type: 'instalment',
        monthly_amount: monthlyPence / 100,
        total_months: months,
        total_amount: totalOwed,
      },
      subscription_data: {
        metadata: {
          debtor_id: debtor.id,
          total_months: months,
          cancel_after: months, // We'll handle cancellation via webhook
        },
      },
      after_completion: { type: 'hosted_confirmation' },
    })

    // Update debtor record
    await supabase.from('debtors').update({
      stripe_payment_link_id: paymentLink.id,
      stripe_payment_link_url: paymentLink.url,
      status: 'payment_plan',
      next_action: `Payment plan: ${months}x £${(monthlyPence/100).toFixed(2)}/month`,
    }).eq('id', debtor.id)

    // Log to timeline
    const monthlyStr = (monthlyPence / 100).toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })
    await supabase.from('timeline').insert({
      debtor_id,
      channel: 'payment',
      direction: 'out',
      status: 'sent',
      result: 'plan_created',
      summary: `Payment plan created: ${months}x ${monthlyStr}/month (total ${totalOwed.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })})`,
      metadata: {
        payment_link_id: paymentLink.id,
        payment_link_url: paymentLink.url,
        monthly_amount: monthlyPence / 100,
        total_months: months,
      },
      executed_at: new Date().toISOString(),
    })

    return NextResponse.json({
      success: true,
      payment_link: paymentLink.url,
      monthly_amount: monthlyPence / 100,
      total_months: months,
      total_amount: totalOwed,
    })
  } catch (error) {
    console.error('Payment plan error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
