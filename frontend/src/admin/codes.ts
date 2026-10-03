// Code lists (F-2.8) are edited as text, one "code = meaning" per line.

export function formatCodes(codes: Record<string, string> | null | undefined): string {
  return Object.entries(codes ?? {})
    .map(([code, meaning]) => (code === meaning ? code : `${code} = ${meaning}`))
    .join('\n')
}

export function parseCodes(text: string): Record<string, string> | null {
  const entries = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf('=')
      if (at < 0) return [line, line] as const
      const code = line.slice(0, at).trim()
      return [code, line.slice(at + 1).trim() || code] as const
    })
    .filter(([code]) => code !== '')
  return entries.length ? Object.fromEntries(entries) : null
}
