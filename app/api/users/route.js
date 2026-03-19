import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export async function POST(request) {
  try {
    const { email, name, role, client_id } = await request.json()
    const supabase = createServerClient()

    // Create auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password: Math.random().toString(36).slice(-12) + 'A1!', // Temp password
      email_confirm: true,
    })

    if (authError) {
      return NextResponse.json({ error: authError.message }, { status: 400 })
    }

    // Create user profile
    const { data, error } = await supabase.from('users').insert({
      id: authData.user.id,
      email,
      name,
      role,
      client_id: client_id || null,
    }).select().single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // TODO: Send welcome email with password reset link via SendGrid

    return NextResponse.json({ success: true, user: data })
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// GET /api/users - list all users
export async function GET() {
  const supabase = createServerClient()
  const { data, error } = await supabase.from('users').select('*, clients(name, color)').order('name')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
