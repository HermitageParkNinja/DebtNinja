import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createServerClient } from '@/lib/supabase'

const getStripe = () => new Stripe(process.env.STRIPE_SECRET_KEY)

export async function POST(request) {
  try {
    const { debtor_id, custom_amount, settlement } = await request.json()
    const stripe = getStripe()
    const supabase = createServerClient()

    // Get debtor details
    const { data: debtor, error } = await supabase
      .from('debtors')
      .select('*')
      .eq('id', debtor_id)
      .single()

    if (error || !debtor) {
      return NextResponse.json({ error: 'Debtor not found' }, { status: 404 })
    }

    // Don't reuse links for settlements - they're a different amount
    if (!custom_amount && !settlement && debtor.stripe_payment_link_url) {
      if (debtor.type === 'cvl') {
        return NextResponse.json({
          success: true,
          payment_link: debtor.stripe_payment_link_url,
          amount: parseFloat(debtor.base_amount) - parseFloat(debtor.payments),
          reused: true,
        })
      }
    }

    // Calculate amount - use custom amount for settlements, otherwise full amount
    let amount
    if (custom_amount) {
      amount = Math.round(custom_amount * 100)
    } else if (debtor.type === 'cvl') {
      amount = Math.round((debtor.base_amount - debtor.payments) * 100)
    } else {
      const now = new Date()
      const invDate = new Date(debtor.invoice_date)
      const days = Math.max(0, Math.floor((now - invDate) / 86400000))
      const total = parseFloat(debtor.principal) + (parseFloat(debtor.daily_interest) * days)
      amount = Math.round((total - debtor.payments) * 100)
    }

    if (amount <= 0) {
      return NextResponse.json({ error: 'No amount outstanding' }, { status: 400 })
    }

    // Create Stripe Payment Link
    const price = await stripe.prices.create({
      currency: 'gbp',
      unit_amount: amount,
      product_data: {
        name: `Payment - ${debtor.company}`,
        metadata: { debtor_id: debtor.id, company: debtor.company },
      },
    })

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: { debtor_id: debtor.id, settlement: settlement ? 'true' : 'false', custom_amount: custom_amount || '' },
      after_completion: { type: 'hosted_confirmation' },
    })

    // Store link on debtor record
    await supabase.from('debtors').update({
      stripe_payment_link_id: paymentLink.id,
      stripe_payment_link_url: paymentLink.url,
    }).eq('id', debtor_id)

    // Log to timeline
    await supabase.from('timeline').insert({
      debtor_id,
      channel: 'payment',
      direction: 'out',
      status: 'sent',
      result: 'link_generated',
      summary: `Stripe payment link generated for ${(amount / 100).toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })}`,
      metadata: { payment_link_id: paymentLink.id, payment_link_url: paymentLink.url, amount: amount / 100 },
      executed_at: new Date().toISOString(),
    })

    return NextResponse.json({
      success: true,
      payment_link: paymentLink.url,
      amount: amount / 100,
    })
  } catch (error) {
    console.error('Stripe API error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
