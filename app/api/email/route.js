import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

const SENDGRID_API = 'https://api.sendgrid.com/v3/mail/send'

export async function POST(request) {
  try {
    const { debtor_id, template, custom_subject, custom_body } = await request.json()
    const supabase = createServerClient()

    const { data: debtor, error } = await supabase
      .from('debtors')
      .select('*')
      .eq('id', debtor_id)
      .single()

    if (error || !debtor) {
      return NextResponse.json({ error: 'Debtor not found' }, { status: 404 })
    }

    if (!debtor.email) {
      return NextResponse.json({ error: 'Debtor has no email address' }, { status: 400 })
    }

    // Calculate current amount
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
    const paymentLink = debtor.stripe_payment_link_url || '[Payment link will be generated]'

    // Email templates
    const templates = {
      initial_demand: {
        subject: `Outstanding Amount - ${debtor.company}`,
        html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
          <p>Dear ${debtor.name},</p>
          <p>We are writing to you in connection with the outstanding sum of <strong>${amountStr}</strong> relating to ${debtor.company}.</p>
          <p>This amount is now due and payable. We request that you arrange payment within <strong>14 days</strong> of the date of this email.</p>
          ${paymentLink !== '[Payment link will be generated]' ? `<p>You can make payment securely online using the following link:</p><p><a href="${paymentLink}" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin: 10px 0;">Pay ${amountStr} Now</a></p>` : ''}
          <p>If you wish to discuss payment arrangements, please contact us at your earliest convenience.</p>
          <p>Failure to make payment or contact us within the stated period may result in further action being taken without additional notice.</p>
          <p>Yours faithfully,</p>
          <p><strong>Zenith Legal Services Group Ltd</strong><br/>settlements@zenithlegalgroup.com</p>
        </div>`
      },
      second_demand: {
        subject: `URGENT: Outstanding Amount - ${debtor.company}`,
        html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
          <p>Dear ${debtor.name},</p>
          <p>We have previously written to you regarding the outstanding sum of <strong>${amountStr}</strong> relating to ${debtor.company}. We have not received payment or a response.</p>
          <p>This is a matter of urgency. If payment is not received or a suitable arrangement proposed within <strong>7 days</strong>, we will have no alternative but to escalate this matter.</p>
          ${paymentLink !== '[Payment link will be generated]' ? `<p><a href="${paymentLink}" style="background: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin: 10px 0;">Pay ${amountStr} Now</a></p>` : ''}
          <p>We strongly recommend that you engage with us promptly to avoid further costs and action.</p>
          <p>Yours faithfully,</p>
          <p><strong>Zenith Legal Services Group Ltd</strong><br/>settlements@zenithlegalgroup.com</p>
        </div>`
      },
      final_demand: {
        subject: `FINAL NOTICE: Outstanding Amount - ${debtor.company}`,
        html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
          <p>Dear ${debtor.name},</p>
          <p><strong>This is our final correspondence before escalation.</strong></p>
          <p>Despite our previous communications, the sum of <strong>${amountStr}</strong> relating to ${debtor.company} remains outstanding.</p>
          <p>If we do not receive full payment or an acceptable proposal within <strong>48 hours</strong>, this matter will be referred for formal legal proceedings without further notice to you.</p>
          ${paymentLink !== '[Payment link will be generated]' ? `<p><a href="${paymentLink}" style="background: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin: 10px 0;">Settle ${amountStr} Now</a></p>` : ''}
          <p>Yours faithfully,</p>
          <p><strong>Zenith Legal Services Group Ltd</strong><br/>settlements@zenithlegalgroup.com</p>
        </div>`
      },
      payment_plan_confirmation: {
        subject: `Payment Arrangement Confirmed - ${debtor.company}`,
        html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
          <p>Dear ${debtor.name},</p>
          <p>Thank you for engaging with us regarding the outstanding sum relating to ${debtor.company}.</p>
          <p>This email confirms the payment arrangement agreed. Please ensure all payments are made on time. Failure to maintain the agreed schedule may result in the full balance becoming immediately due and further action being taken.</p>
          ${paymentLink !== '[Payment link will be generated]' ? `<p>You can make payments using the following link:</p><p><a href="${paymentLink}" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin: 10px 0;">Make Payment</a></p>` : ''}
          <p>Yours faithfully,</p>
          <p><strong>Zenith Legal Services Group Ltd</strong><br/>settlements@zenithlegalgroup.com</p>
        </div>`
      },
    }

    const tpl = template && templates[template] ? templates[template] : null
    const subject = custom_subject || (tpl ? tpl.subject : `Regarding ${debtor.company}`)
    const html = custom_body || (tpl ? tpl.html : `<p>Dear ${debtor.name},</p><p>Please contact us regarding ${debtor.company}.</p>`)

    // Send via SendGrid
    const sgResponse = await fetch(SENDGRID_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: debtor.email, name: debtor.name }] }],
        from: { email: process.env.SENDGRID_FROM_EMAIL || 'settlements@zenithlegalgroup.com', name: 'Zenith Legal Services' },
        subject,
        content: [{ type: 'text/html', value: html }],
        tracking_settings: {
          open_tracking: { enable: true },
          click_tracking: { enable: true },
        },
      }),
    })

    if (!sgResponse.ok) {
      const sgError = await sgResponse.text()
      console.error('SendGrid error:', sgError)
      return NextResponse.json({ error: 'Email delivery failed: ' + sgError }, { status: 500 })
    }

    const messageId = sgResponse.headers.get('x-message-id')

    // Log to timeline
    await supabase.from('timeline').insert({
      debtor_id,
      channel: 'email',
      direction: 'out',
      status: 'sent',
      result: 'delivered',
      summary: `${template || 'custom'} email sent to ${debtor.email}`,
      metadata: { message_id: messageId, template: template || 'custom', subject },
      executed_at: new Date().toISOString(),
    })

    // Update debtor
    await supabase.from('debtors').update({
      last_contact: new Date().toISOString(),
    }).eq('id', debtor_id)

    return NextResponse.json({ success: true, message_id: messageId })
  } catch (error) {
    console.error('Email API error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
