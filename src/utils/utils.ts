
/**
 * Check if a line is empty or contains only whitespace
 * Optimized version using character traversal
 */
export function isLineEmptyOrWhitespace(line: string): boolean {
  if (!line || line.length === 0) return true;
  
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    // 32: space, 9: tab, 10: \n, 13: \r
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) {
      return false;
    }
  }
  return true;
}

/**
 * Parse date string in various formats
 * Supports YYYYMMDDHHMMSS (14 digits), YYYYMMDDHHMM (12 digits), YYYYMMDDHH (10 digits), YYYYMMDD (8 digits), or standard Date string
 * All date-only formats are interpreted in UTC+8 (Beijing time)
 */
export function parseDate(dateStr: string | undefined): Date | undefined {
  if (!dateStr) return undefined;

  // Support YYYYMMDDHHMMSS format (14 digits) — interpreted in UTC+8
  if (/^\d{14}$/.test(dateStr)) {
    const y = parseInt(dateStr.slice(0, 4), 10);
    const m = parseInt(dateStr.slice(4, 6), 10) - 1;
    const d = parseInt(dateStr.slice(6, 8), 10);
    const h = parseInt(dateStr.slice(8, 10), 10);
    const min = parseInt(dateStr.slice(10, 12), 10);
    const s = parseInt(dateStr.slice(12, 14), 10);
    // UTC+8: local = UTC + 8h → UTC = local - 8h
    return new Date(Date.UTC(y, m, d, h - 8, min, s));
  }
  // Support YYYYMMDDHHMM format (12 digits) — interpreted in UTC+8
  if (/^\d{12}$/.test(dateStr)) {
    const y = parseInt(dateStr.slice(0, 4), 10);
    const m = parseInt(dateStr.slice(4, 6), 10) - 1;
    const d = parseInt(dateStr.slice(6, 8), 10);
    const h = parseInt(dateStr.slice(8, 10), 10);
    const min = parseInt(dateStr.slice(10, 12), 10);
    // UTC+8: local = UTC + 8h → UTC = local - 8h
    return new Date(Date.UTC(y, m, d, h - 8, min));
  }
  // Support YYYYMMDDHH format (10 digits) — interpreted in UTC+8, minutes = 00
  if (/^\d{10}$/.test(dateStr)) {
    const y = parseInt(dateStr.slice(0, 4), 10);
    const m = parseInt(dateStr.slice(4, 6), 10) - 1;
    const d = parseInt(dateStr.slice(6, 8), 10);
    const h = parseInt(dateStr.slice(8, 10), 10);
    return new Date(Date.UTC(y, m, d, h - 8, 0));
  }
  // Support YYYYMMDD format — interpreted as start of day in UTC+8 (00:00 UTC+8)
  if (/^\d{8}$/.test(dateStr)) {
    const y = parseInt(dateStr.slice(0, 4), 10);
    const m = parseInt(dateStr.slice(4, 6), 10) - 1;
    const d = parseInt(dateStr.slice(6, 8), 10);
    // 00:00 UTC+8 = 16:00 UTC previous day
    return new Date(Date.UTC(y, m, d - 1, 16, 0, 0));
  }
  return new Date(dateStr);
}
