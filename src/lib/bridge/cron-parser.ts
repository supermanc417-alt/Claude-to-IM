/**
 * Cron Expression Parser
 *
 * Parses standard 5-field cron expressions: minute hour day-of-month month day-of-week
 * Supports wildcards, single values (5), steps (e.g. every 15), ranges (1-5), and comma-separated lists (1,15,30)
 *
 * Examples:
 *   "* * * * *"     - Every minute
 *   "every 5 * * * *"   - Every 5 minutes
 *   "0 * * * *"     - Every hour on the hour
 *   "0 9 * * *"     - Every day at 9am
 *   "0 9 * * 1-5"   - Weekdays at 9am
 *   "30 14 15 3 *"  - March 15 at 2:30pm
 */

export interface CronSchedule {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

export function parseCron(expression: string): CronSchedule {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
  }

  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dayOfWeek: parseField(parts[4], 0, 6),
  };
}

function parseField(field: string, min: number, max: number): number[] {
  const values: number[] = [];

  // Handle comma-separated lists
  const parts = field.split(',');
  for (const part of parts) {
    // Handle step (e.g., "*/5" or "1-10/2")
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) {
        throw new Error(`Invalid step value: ${stepStr}`);
      }

      let rangeValues: number[];
      if (range === '*') {
        rangeValues = Array.from({ length: max - min + 1 }, (_, i) => min + i);
      } else if (range.includes('-')) {
        rangeValues = parseRange(range, min, max);
      } else {
        const single = parseInt(range, 10);
        if (isNaN(single)) {
          throw new Error(`Invalid range: ${range}`);
        }
        rangeValues = [single];
      }

      for (let i = 0; i < rangeValues.length; i += step) {
        if (!values.includes(rangeValues[i])) {
          values.push(rangeValues[i]);
        }
      }
    }
    // Handle ranges (e.g., "1-5")
    else if (part.includes('-')) {
      const rangeValues = parseRange(part, min, max);
      for (const v of rangeValues) {
        if (!values.includes(v)) {
          values.push(v);
        }
      }
    }
    // Handle wildcard
    else if (part === '*') {
      for (let i = min; i <= max; i++) {
        values.push(i);
      }
    }
    // Handle single value
    else {
      const value = parseInt(part, 10);
      if (isNaN(value)) {
        throw new Error(`Invalid field value: ${part}`);
      }
      if (value < min || value > max) {
        throw new Error(`Value ${value} out of range [${min}, ${max}]`);
      }
      if (!values.includes(value)) {
        values.push(value);
      }
    }
  }

  return values.sort((a, b) => a - b);
}

function parseRange(range: string, min: number, max: number): number[] {
  const [startStr, endStr] = range.split('-');
  const start = parseInt(startStr, 10);
  const end = parseInt(endStr, 10);

  if (isNaN(start) || isNaN(end)) {
    throw new Error(`Invalid range: ${range}`);
  }

  if (start < min || end > max || start > end) {
    throw new Error(`Range ${range} out of bounds or invalid`);
  }

  const values: number[] = [];
  for (let i = start; i <= end; i++) {
    values.push(i);
  }
  return values;
}

/**
 * Get the next scheduled time for a cron expression after a given date.
 * Returns null if no next time can be calculated (shouldn't happen with valid cron).
 */
export function getNextCronTime(schedule: CronSchedule, after: Date = new Date()): Date | null {
  const date = new Date(after);
  // Start from the next minute
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);

  // Try to find the next match (max 4 years ahead to prevent infinite loops)
  const maxIterations = 4 * 365 * 24 * 60;
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    const month = date.getMonth() + 1; // JS months are 0-indexed
    const dayOfMonth = date.getDate();
    const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday
    const hour = date.getHours();
    const minute = date.getMinutes();

    // Check if current time matches all fields
    if (
      schedule.month.includes(month) &&
      schedule.dayOfMonth.includes(dayOfMonth) &&
      schedule.dayOfWeek.includes(dayOfWeek) &&
      schedule.hour.includes(hour) &&
      schedule.minute.includes(minute)
    ) {
      return new Date(date);
    }

    // Advance to the next minute
    date.setMinutes(date.getMinutes() + 1);

    // Handle overflow
    if (date.getMinutes() === 0) {
      // Check if we need to advance to next valid hour
      while (!schedule.hour.includes(date.getHours())) {
        date.setHours(date.getHours() + 1);
        if (date.getHours() === 0) {
          // Day overflow, handled by next check
          break;
        }
      }

      // Handle day overflow (check both day of month and day of week)
      if (date.getHours() === 0) {
        const attempts = maxDaysToSearch;
        let daysSearched = 0;

        while (
          daysSearched < attempts &&
          (!schedule.dayOfMonth.includes(date.getDate()) ||
            !schedule.dayOfWeek.includes(date.getDay()))
        ) {
          date.setDate(date.getDate() + 1);
          date.setHours(0, 0, 0);
          daysSearched++;
        }

        // Handle month overflow
        if (date.getDate() === 1 && daysSearched > 0) {
          while (!schedule.month.includes(date.getMonth() + 1)) {
            date.setMonth(date.getMonth() + 1);
            if (date.getMonth() === 0) {
              date.setFullYear(date.getFullYear() + 1);
            }
            date.setDate(1);
            date.setHours(0, 0, 0);
          }
        }
      }
    }
  }

  return null;
}

// Maximum days to search for a matching day (prevents infinite loops)
const maxDaysToSearch = 400; // ~13 months

/**
 * Check if a given date matches a cron schedule.
 */
export function matchesCron(schedule: CronSchedule, date: Date): boolean {
  const month = date.getMonth() + 1;
  const dayOfMonth = date.getDate();
  const dayOfWeek = date.getDay();
  const hour = date.getHours();
  const minute = date.getMinutes();

  return (
    schedule.month.includes(month) &&
    schedule.dayOfMonth.includes(dayOfMonth) &&
    schedule.dayOfWeek.includes(dayOfWeek) &&
    schedule.hour.includes(hour) &&
    schedule.minute.includes(minute)
  );
}

/**
 * Convert a simple interval (e.g., "5m", "1h") to a cron expression.
 */
export function intervalToCron(interval: string): string {
  const match = interval.match(/^(\d+)([smhd])$/i);
  if (!match) {
    throw new Error(`Invalid interval: ${interval}`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 's':
      // Seconds - round up to minutes
      const minutes = Math.ceil(value / 60);
      if (minutes >= 60) {
        return intervalToCron(`${Math.ceil(minutes / 60)}h`);
      }
      return minutes === 1 ? '* * * * *' : `*/${minutes} * * * *`;

    case 'm':
      if (value >= 60) {
        return intervalToCron(`${Math.ceil(value / 60)}h`);
      }
      return value === 1 ? '* * * * *' : `*/${value} * * * *`;

    case 'h':
      if (value >= 24) {
        return intervalToCron(`${Math.ceil(value / 24)}d`);
      }
      return `0 */${value} * * *`;

    case 'd':
      if (value > 31) {
        throw new Error(`Interval too large: ${value} days`);
      }
      return `0 0 */${value} * *`;

    default:
      throw new Error(`Unknown interval unit: ${unit}`);
  }
}
