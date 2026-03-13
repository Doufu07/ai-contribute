
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
 * Supports YYYYMMDDHHMM (12 digits), YYYYMMDD (8 digits), or standard Date string
 */
export function parseDate(dateStr: string): Date {
  // Support YYYYMMDDHHMM format (12 digits)
  if (/^\d{12}$/.test(dateStr)) {
    const y = parseInt(dateStr.slice(0, 4), 10);
    const m = parseInt(dateStr.slice(4, 6), 10) - 1;
    const d = parseInt(dateStr.slice(6, 8), 10);
    const h = parseInt(dateStr.slice(8, 10), 10);
    const min = parseInt(dateStr.slice(10, 12), 10);
    return new Date(y, m, d, h, min);
  }
  // Support YYYYMMDD format
  if (/^\d{8}$/.test(dateStr)) {
    const y = parseInt(dateStr.slice(0, 4), 10);
    const m = parseInt(dateStr.slice(4, 6), 10) - 1;
    const d = parseInt(dateStr.slice(6, 8), 10);
    return new Date(y, m, d);
  }
  return new Date(dateStr);
}
