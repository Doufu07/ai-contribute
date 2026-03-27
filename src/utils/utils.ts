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

// 注意：parseDate 已迁移到 time.ts，使用东八区时间
// import { parseDate } from './time.js';
