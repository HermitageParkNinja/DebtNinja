// Parse natural language date/time from call transcripts
// Handles: "tomorrow at 2pm", "Wednesday 1pm", "next Monday morning", "1pm Wednesday", "3rd April at 10am"
 
export function parseCallbackDate(text) {
  if (!text || !text.trim()) return null
 
  const lower = text.toLowerCase().trim()
  const now = new Date()
  const result = new Date(now)
  result.setSeconds(0, 0)
 
  // Extract time
  let hour = null
  let minute = 0
 
  // Match patterns like "1pm", "2:30pm", "10am", "14:00"
  const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i) || lower.match(/(\d{1,2}):(\d{2})/)
  if (timeMatch) {
    hour = parseInt(timeMatch[1])
    minute = parseInt(timeMatch[2] || '0')
    if (timeMatch[3]) {
      const ampm = timeMatch[3].toLowerCase()
      if (ampm === 'pm' && hour !== 12) hour += 12
      if (ampm === 'am' && hour === 12) hour = 0
    }
  }
 
  // Check for "morning", "afternoon", "evening" if no specific time
  if (hour === null) {
    if (lower.includes('morning')) hour = 10
    else if (lower.includes('afternoon')) hour = 14
    else if (lower.includes('evening')) hour = 17
    else hour = 10 // Default to 10am
  }
 
  // Extract day
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
 
  if (lower.includes('tomorrow')) {
    result.setDate(result.getDate() + 1)
  } else if (lower.includes('today')) {
    // Keep today
  } else if (lower.match(/next\s+week/)) {
    result.setDate(result.getDate() + 7)
  } else {
    // Check for day names
    for (let i = 0; i < dayNames.length; i++) {
      if (lower.includes(dayNames[i])) {
        const currentDay = now.getDay()
        let daysAhead = i - currentDay
        if (daysAhead <= 0) daysAhead += 7 // Next occurrence
        result.setDate(result.getDate() + daysAhead)
        break
      }
    }
 
    // Check for specific dates like "3rd April", "April 3rd", "3/4"
    const dateMatch = lower.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i)
      || lower.match(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?/i)
 
    if (dateMatch) {
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }
      let day, monthStr
      if (dateMatch[1].match(/\d/)) {
        day = parseInt(dateMatch[1])
        monthStr = dateMatch[2].substring(0, 3).toLowerCase()
      } else {
        monthStr = dateMatch[1].substring(0, 3).toLowerCase()
        day = parseInt(dateMatch[2])
      }
      const month = months[monthStr]
      if (month !== undefined && day) {
        result.setMonth(month, day)
        if (result <= now) result.setFullYear(result.getFullYear() + 1)
      }
    }
  }
 
  result.setHours(hour, minute, 0, 0)
 
  // Don't schedule in the past
  if (result <= now) {
    // If the time is past but it's today, push to tomorrow
    result.setDate(result.getDate() + 1)
  }
 
  // Don't schedule on weekends
  while (result.getDay() === 0 || result.getDay() === 6) {
    result.setDate(result.getDate() + 1)
  }
 
  // Clamp to working hours
  if (result.getHours() < 9) result.setHours(9, 0, 0, 0)
  if (result.getHours() >= 18) {
    result.setDate(result.getDate() + 1)
    result.setHours(9, 0, 0, 0)
    while (result.getDay() === 0 || result.getDay() === 6) {
      result.setDate(result.getDate() + 1)
    }
  }
 
  return result.toISOString()
}
