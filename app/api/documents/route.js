import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

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

async function extractFilesFromZip(buffer) {
  try {
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(buffer)
    const files = []
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue
      const name = path.split('/').pop()
      if (!name || name.startsWith('.') || name.startsWith('__')) continue
      const lower = name.toLowerCase()
      if (lower.endsWith('.pdf') || lower.endsWith('.txt') || lower.endsWith('.csv') || lower.endsWith('.doc') || lower.endsWith('.docx')) {
        const content = await entry.async('nodebuffer')
        files.push({ name, buffer: content, type: lower.endsWith('.pdf') ? 'application/pdf' : 'text/plain' })
      }
    }
    return files
  } catch (err) {
    console.error('Zip extraction error:', err)
    return []
  }
}

async function extractText(name, buffer) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.pdf')) {
    return await extractTextFromPDF(buffer)
  } else if (lower.endsWith('.txt') || lower.endsWith('.csv')) {
    return buffer.toString('utf-8')
  }
  return `[File: ${name} - ${(buffer.length / 1024).toFixed(0)} KB]`
}

function detectDocType(name) {
  const lower = name.toLowerCase()
  if (lower.includes('bank') || lower.includes('statement')) return 'bank_analysis'
  if (lower.includes('dcr') || lower.includes('conduct')) return 'dcr'
  if (lower.includes('lexis') || lower.includes('trace')) return 'lexisnexis'
  if (lower.includes('correspond') || lower.includes('letter')) return 'correspondence'
  if (lower.includes('invoice') || lower.includes('inv')) return 'invoice'
  if (lower.includes('contract') || lower.includes('terms')) return 'contract'
  if (lower.includes('soa') || lower.includes('affairs')) return 'statement_of_affairs'
  return 'other'
}

// Extend timeout for large file processing
export const maxDuration = 120 // 2 minutes

export async function POST(request) {
  try {
    const formData = await request.formData()
    const rawFiles = formData.getAll('files')
    const debtorId = formData.get('debtor_id')
    const supabase = createServerClient()

    const uploaded = []
    let allExtractedText = ''
    let totalChars = 0
    const MAX_CHARS = 80000 // ~20k tokens for Claude, leaves room for system prompt

    // Flatten: extract zips into individual files
    const filesToProcess = []
    for (const file of rawFiles) {
      const buffer = Buffer.from(await file.arrayBuffer())
      if (file.name.toLowerCase().endsWith('.zip')) {
        const zipFiles = await extractFilesFromZip(buffer)
        filesToProcess.push(...zipFiles)
      } else {
        filesToProcess.push({ name: file.name, buffer, type: file.type })
      }
    }

    // Process each file
    for (const file of filesToProcess) {
      const fileName = `${debtorId}/${Date.now()}_${file.name}`
      const docType = detectDocType(file.name)

      // Upload to storage
      const { error: storageError } = await supabase.storage
        .from('documents')
        .upload(fileName, file.buffer, { contentType: file.type })

      if (storageError) {
        console.error('Storage upload error:', storageError)
        // Don't stop - continue with other files
      }

      // Extract text
      let extractedText = ''
      if (totalChars < MAX_CHARS) {
        extractedText = await extractText(file.name, file.buffer)
        // Truncate individual file if too long
        if (extractedText.length > 15000) {
          extractedText = extractedText.substring(0, 15000) + '\n[... truncated, document continues ...]'
        }
        totalChars += extractedText.length
      }

      // Record in database
      const { data: docRecord } = await supabase.from('documents').insert({
        debtor_id: debtorId,
        filename: file.name,
        file_path: fileName,
        file_size: file.buffer.length,
        doc_type: docType,
        processed: !!extractedText,
      }).select().single()

      if (extractedText && totalChars <= MAX_CHARS) {
        allExtractedText += `\n\n--- ${file.name} (${docType}) ---\n${extractedText}`
      } else if (!extractedText) {
        allExtractedText += `\n\n--- ${file.name} (${docType}, ${(file.buffer.length/1024).toFixed(0)} KB) ---\n[File too large or could not be parsed - name and metadata only]`
      }

      uploaded.push({
        id: docRecord?.id,
        filename: file.name,
        size: file.buffer.length,
        doc_type: docType,
        text_length: extractedText.length,
      })
    }

    return NextResponse.json({
      success: true,
      files: uploaded,
      file_count: uploaded.length,
      extracted_text: allExtractedText,
      total_chars: totalChars,
      truncated: totalChars >= MAX_CHARS,
    })
  } catch (error) {
    console.error('Upload error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
