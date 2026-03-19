import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// Extract text from PDF
async function extractTextFromPDF(buffer) {
  try {
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default
    const data = await pdfParse(buffer)
    return data.text || ''
  } catch (err) {
    console.error('PDF parse error:', err)
    return ''
  }
}

async function extractText(file, buffer) {
  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf')) {
    return await extractTextFromPDF(buffer)
  } else if (name.endsWith('.txt') || name.endsWith('.csv')) {
    return buffer.toString('utf-8')
  }
  return `[File: ${file.name} - ${(buffer.length / 1024).toFixed(0)} KB]`
}

export async function POST(request) {
  try {
    const formData = await request.formData()
    const files = formData.getAll('files')
    const debtorId = formData.get('debtor_id')
    const supabase = createServerClient()

    const uploaded = []
    let allExtractedText = ''

    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer())
      const fileName = `${debtorId}/${Date.now()}_${file.name}`

      const { error: storageError } = await supabase.storage
        .from('documents')
        .upload(fileName, buffer, { contentType: file.type })

      if (storageError) {
        console.error('Storage upload error:', storageError)
        continue
      }

      const extractedText = await extractText(file, buffer)

      const name = file.name.toLowerCase()
      let docType = 'other'
      if (name.includes('bank') || name.includes('statement')) docType = 'bank_analysis'
      else if (name.includes('dcr') || name.includes('conduct')) docType = 'dcr'
      else if (name.includes('lexis') || name.includes('trace')) docType = 'lexisnexis'
      else if (name.includes('correspond') || name.includes('letter')) docType = 'correspondence'
      else if (name.includes('invoice') || name.includes('inv')) docType = 'invoice'
      else if (name.includes('contract') || name.includes('terms')) docType = 'contract'
      else if (name.includes('soa') || name.includes('affairs')) docType = 'statement_of_affairs'

      const { data: docRecord } = await supabase.from('documents').insert({
        debtor_id: debtorId,
        filename: file.name,
        file_path: fileName,
        file_size: buffer.length,
        doc_type: docType,
        processed: !!extractedText,
      }).select().single()

      allExtractedText += `\n\n--- ${file.name} (${docType}) ---\n${extractedText}`

      uploaded.push({
        id: docRecord?.id,
        filename: file.name,
        size: buffer.length,
        doc_type: docType,
        text_length: extractedText.length,
      })
    }

    return NextResponse.json({ success: true, files: uploaded, extracted_text: allExtractedText })
  } catch (error) {
    console.error('Upload error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

