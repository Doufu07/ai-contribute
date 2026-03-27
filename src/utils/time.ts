/**
 * 时间处理工具模块 - 统一使用东八区 (Asia/Shanghai)
 * 所有时间相关操作都应通过此模块进行，确保时区一致性
 */

/** 东八区时区偏移（分钟） */
export const CST_OFFSET_MINUTES = -480; // UTC+8 = -480 分钟偏移

/** 东八区时区字符串 */
export const TZ_CST = 'Asia/Shanghai';

/**
 * 将 Date 对象格式化为东八区 ISO 字符串（供 Git 使用）
 * 格式: 2026-03-10T00:00:00+08:00
 */
export function formatCSTISO(date: Date): string {
  // 获取东八区时间组件
  const cstDate = toCSTDate(date);

  const year = cstDate.getFullYear();
  const month = (cstDate.getMonth() + 1).toString().padStart(2, '0');
  const day = cstDate.getDate().toString().padStart(2, '0');
  const hours = cstDate.getHours().toString().padStart(2, '0');
  const minutes = cstDate.getMinutes().toString().padStart(2, '0');
  const seconds = cstDate.getSeconds().toString().padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+08:00`;
}

/**
 * 将任意 Date 转换为东八区 Date 对象
 */
export function toCSTDate(date: Date): Date {
  // 获取 UTC 时间戳
  const utcTimestamp = date.getTime();
  // 加上东八区偏移 (8小时 = 28800000毫秒)
  return new Date(utcTimestamp + 8 * 60 * 60 * 1000);
}

/**
 * 解析日期字符串，统一返回东八区零点或指定时间的 Date 对象
 *
 * 支持格式：
 * - YYYYMMDD (8位)     → 20260310 → 2026-03-10 00:00:00 CST
 * - YYYYMMDDHHMM (12位) → 202603100830 → 2026-03-10 08:30:00 CST
 * - ISO 8601 标准格式
 * - 其他标准 Date 可解析的字符串
 *
 * @param dateStr 日期字符串
 * @returns Date 对象（UTC 时间，但表示的是东八区的指定时间）
 */
export function parseDate(dateStr: string | undefined): Date | undefined {
  if (!dateStr) return undefined;

  // 8位数字: YYYYMMDD → 默认 00:00:00 CST
  if (/^\d{8}$/.test(dateStr)) {
    const y = parseInt(dateStr.slice(0, 4), 10);
    const m = parseInt(dateStr.slice(4, 6), 10) - 1; // 月份 0-11
    const d = parseInt(dateStr.slice(6, 8), 10);
    // 创建东八区时间（使用本地时区但按东八区解析）
    return createCSTDate(y, m, d, 0, 0, 0);
  }

  // 12位数字: YYYYMMDDHHMM → 精确到分钟
  if (/^\d{12}$/.test(dateStr)) {
    const y = parseInt(dateStr.slice(0, 4), 10);
    const m = parseInt(dateStr.slice(4, 6), 10) - 1;
    const d = parseInt(dateStr.slice(6, 8), 10);
    const h = parseInt(dateStr.slice(8, 10), 10);
    const min = parseInt(dateStr.slice(10, 12), 10);
    return createCSTDate(y, m, d, h, min, 0);
  }

  // 14位数字: YYYYMMDDHHMMSS → 精确到秒
  if (/^\d{14}$/.test(dateStr)) {
    const y = parseInt(dateStr.slice(0, 4), 10);
    const m = parseInt(dateStr.slice(4, 6), 10) - 1;
    const d = parseInt(dateStr.slice(6, 8), 10);
    const h = parseInt(dateStr.slice(8, 10), 10);
    const min = parseInt(dateStr.slice(10, 12), 10);
    const s = parseInt(dateStr.slice(12, 14), 10);
    return createCSTDate(y, m, d, h, min, s);
  }

  // 其他格式：尝试标准解析，假设是东八区时间
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    // 如果是 ISO 格式且包含时区信息，直接返回
    // 否则假设是本地时间（东八区）
    return parsed;
  }

  return undefined;
}

/**
 * 创建东八区 Date 对象
 * @param year 年
 * @param month 月 (0-11)
 * @param day 日
 * @param hours 时 (0-23)
 * @param minutes 分 (0-59)
 * @param seconds 秒 (0-59)
 * @returns Date 对象（UTC 时间）
 */
export function createCSTDate(
  year: number,
  month: number,
  day: number,
  hours: number = 0,
  minutes: number = 0,
  seconds: number = 0
): Date {
  // 创建 UTC 时间戳：东八区时间 - 8小时 = UTC 时间
  // 使用 Date.UTC 创建 UTC 时间，然后减去 8 小时偏移
  const utcTimestamp = Date.UTC(year, month, day, hours, minutes, seconds) - 8 * 60 * 60 * 1000;
  return new Date(utcTimestamp);
}

/**
 * 获取 Git 命令使用的环境变量（强制东八区）
 * 用于 execFileSync 等命令执行时的 env 参数
 */
export function getGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TZ: TZ_CST,
  };
}

/**
 * 将 Date 对象转换为东八区的 YYYY-MM-DD HH:MM:SS 格式（用于显示）
 */
export function formatCSTDisplay(date: Date): string {
  const cstDate = toCSTDate(date);

  const year = cstDate.getFullYear();
  const month = (cstDate.getMonth() + 1).toString().padStart(2, '0');
  const day = cstDate.getDate().toString().padStart(2, '0');
  const hours = cstDate.getHours().toString().padStart(2, '0');
  const minutes = cstDate.getMinutes().toString().padStart(2, '0');
  const seconds = cstDate.getSeconds().toString().padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} CST`;
}

/**
 * 获取当前时间的东八区 Date 对象
 */
export function nowCST(): Date {
  return toCSTDate(new Date());
}
