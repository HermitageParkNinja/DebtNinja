import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// GET /api/debtors - List all debtors
export async function GET(request) {
  const supabase = createServerClient()
  const { searchParams } = new URL(request.url)

  let query = supabase
    .from('debtors')
    .select(`
      *,
      intelligence (confidence, claim_strength, claims, assets, flags, breakdown),
      timeline (id, sequence_day, channel, status, result, summary, transcript, executed_at)
    `)
    .order('created_at', { ascending: false })

  const clientId = searchParams.get('client')
  if (clientId && clientId !== 'all') query = query.eq('client_id', clientId)

  const status = searchParams.get('status')
  if (status && status !== 'all') query = query.eq('status', status)

  const search = searchParams.get('search')
  if (search) query = query.or(`name.ilike.%${search}%,company.ilike.%${search}%`)

  const { data, error } = await query

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// POST /api/debtors - Create new debtor
export async function POST(request) {
  const supabase = createServerClient()
  const body = await request.json()

  const { data, error } = await supabase.from('debtors').insert({
    client_id: body.client_id,
    type: body.type,
    name: body.name,
    company: body.company,
    co_number: body.co_number,
    email: body.email,
    phone: body.phone,
    address: body.address,
    base_amount: body.base_amount || 0,
    principal: body.principal || 0,
    daily_interest: body.daily_interest || 79,
    invoice_date: body.invoice_date || null,
    priority: body.priority || 'medium',
    status: 'queued',
    next_action: 'Sequence starts tomorrow',
  }).select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// PATCH /api/debtors - Update debtor
export async function PATCH(request) {
  const supabase = createServerClient()
  const body = await request.json()
  const { id, ...updates } = body

  const { data, error } = await supabase
    .from('debtors')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
