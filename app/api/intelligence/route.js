import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createServerClient } from '@/lib/supabase'

const getAnthropic = () => new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const CVL_SYSTEM_PROMPT = `You are an expert UK insolvency analyst working for a debt recovery firm. You analyse case documents (bank statement analyses, Director's Conduct Reports, LexisNexis trace reports, Statements of Affairs, correspondence) and extract structured intelligence about recoverable amounts.

Your job is to:
1. Identify every applicable legal claim (ODLA under s212 IA1986, wrongful trading s214, preferences s239, misfeasance s212, BBL misuse, transaction at undervalue s238)
2. Quantify the total recoverable amount with a line-by-line breakdown
3. Identify any assets the director holds (property, vehicles, other directorships, valuables)
4. Flag risks, concerns, and strategic considerations
5. Assess claim strength
6. Suggest recovery priority (high/medium/low)

Respond ONLY with valid JSON in this exact format, no markdown, no backticks:
{
  "confidence": 85,
  "claim_strength": "Strong",
  "suggested_priority": "high",
  "total_recoverable": 24500.00,
  "claims": ["ODLA s212 - Overdrawn director loan account (£16,400)", "Preference s239 - Payment to connected party (£4,200)"],
  "assets": ["Residential property identified via trace (est. £310k)"],
  "flags": ["Property not declared on Statement of Affairs", "Connected party payment likely voidable"],
  "breakdown": [{"desc": "Overdrawn DLA", "amt": 16400.00}, {"desc": "Preference claim", "amt": 4200.00}]
}`

const COMMERCIAL_SYSTEM_PROMPT = `You are an expert UK commercial debt recovery analyst. You analyse invoices, contracts, and correspondence to assess debt recovery prospects.

Your job is to:
1. Verify the debt amount and contractual basis
2. Identify applicable interest provisions (contractual or Late Payment of Commercial Debts Act 1998)
3. Assess the debtor company's ability to pay
4. Flag any defences the debtor might raise
5. Suggest recovery priority

Respond ONLY with valid JSON in this exact format, no markdown, no backticks:
{
  "confidence": 90,
  "claim_strength": "Strong - contractual",
  "suggested_priority": "medium",
  "principal": 4200.00,
  "daily_interest": 79.00,
  "invoice_date": "2026-02-01",
  "claims": ["Unpaid invoice #INV-2026-0041 (£4,200)", "Contractual daily interest at £79/day"],
  "assets": ["Active trading company"],
  "flags": ["45 days overdue", "Interest accruing daily"],
  "breakdown": [{"desc": "Invoice principal", "amt": 4200.00}, {"desc": "Accrued interest (45 days)", "amt": 3555.00}]
}`

export async function POST(request) {
  try {
    const { debtor_id, type, documents_text } = await request.json()

    if (!documents_text || documents_text.trim().length === 0) {
      return NextResponse.json({ error: 'No document text provided' }, { status: 400 })
    }

    const systemPrompt = type === 'cvl' ? CVL_SYSTEM_PROMPT : COMMERCIAL_SYSTEM_PROMPT

    const anthropic = getAnthropic()
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Analyse the following case documents and extract the intelligence:\n\n${documents_text}`
      }]
    })

    const responseText = message.content[0].text
    let analysis

    try {
      // Strip any markdown backticks if present
      const cleaned = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      analysis = JSON.parse(cleaned)
    } catch (parseError) {
      console.error('Failed to parse Claude response:', responseText)
      return NextResponse.json({ error: 'AI analysis returned invalid format', raw: responseText }, { status: 500 })
    }

    // Store intelligence in database if we have a debtor_id
    if (debtor_id) {
      const supabase = createServerClient()

      await supabase.from('intelligence').insert({
        debtor_id,
        confidence: analysis.confidence,
        claim_strength: analysis.claim_strength,
        total_recoverable: analysis.total_recoverable || null,
        claims: analysis.claims,
        assets: analysis.assets,
        flags: analysis.flags,
        breakdown: analysis.breakdown,
        raw_analysis: responseText,
      })

      // Update debtor with AI-determined amount for CVL
      if (type === 'cvl' && analysis.total_recoverable) {
        await supabase.from('debtors').update({
          base_amount: analysis.total_recoverable,
          priority: analysis.suggested_priority,
        }).eq('id', debtor_id)
      }

      // Update debtor with commercial details
      if (type === 'commercial' && analysis.principal) {
        await supabase.from('debtors').update({
          principal: analysis.principal,
          daily_interest: analysis.daily_interest,
          invoice_date: analysis.invoice_date,
          priority: analysis.suggested_priority,
        }).eq('id', debtor_id)
      }
    }

    return NextResponse.json({ success: true, analysis })
  } catch (error) {
    console.error('Intelligence API error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
