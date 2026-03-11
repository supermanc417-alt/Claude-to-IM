/**
 * Schedule Broker — handles scheduled task callbacks from IM channels
 * and manages task-related commands.
 *
 * Similar to permission-broker, this module:
 * 1. Formats task lists with inline keyboard buttons
 * 2. Sends them via the delivery layer
 * 3. Handles user responses via inline buttons
 * 4. Processes task-related commands (/tasks, /schedule, etc.)
 */

import type { OutboundMessage, ChannelAddress } from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import type { ScheduledTask, ScheduleConfig, TaskCreateInput, TaskStatus } from './scheduled-tasks-store.js';
import { checkOpenClawHealth, formatHealthMessage } from './openclaw-health-check.js';
import { getScheduledTasksStore } from './scheduled-tasks-store.js';
import { deliver } from './delivery-layer.js';
import { escapeHtml } from './adapters/telegram-utils.js';

// ── Command Parser ──

export interface ScheduleCommand {
  type: 'create' | 'list' | 'delete' | 'pause' | 'resume' | 'info' | 'openclaw';
  args: Record<string, unknown>;
  rawInput: string;
}

export function parseScheduleCommand(input: string): ScheduleCommand | null {
  const trimmed = input.trim();

  // /tasks [filter]
  if (trimmed.startsWith('/tasks')) {
    const rest = trimmed.slice('/tasks'.length).trim();
    return {
      type: 'list',
      args: rest ? { status: rest } : {},
      rawInput: trimmed,
    };
  }

  // /schedule <type> <params> <message>
  if (trimmed.startsWith('/schedule ')) {
    const rest = trimmed.slice('/schedule '.length).trim();
    return parseScheduleCreate(rest);
  }

  // /task delete <id>
  if (trimmed.startsWith('/task delete ')) {
    const rest = trimmed.slice('/task delete '.length).trim();
    return {
      type: 'delete',
      args: { id: rest },
      rawInput: trimmed,
    };
  }

  // /task pause <id>
  if (trimmed.startsWith('/task pause ')) {
    const rest = trimmed.slice('/task pause '.length).trim();
    return {
      type: 'pause',
      args: { id: rest },
      rawInput: trimmed,
    };
  }

  // /task resume <id>
  if (trimmed.startsWith('/task resume ')) {
    const rest = trimmed.slice('/task resume '.length).trim();
    return {
      type: 'resume',
      args: { id: rest },
      rawInput: trimmed,
    };
  }

  // /task info <id>
  if (trimmed.startsWith('/task info ')) {
    const rest = trimmed.slice('/task info '.length).trim();
    return {
      type: 'info',
      args: { id: rest },
      rawInput: trimmed,
    };
  }

  // /openclaw - Check OpenClaw health
  if (trimmed === '/openclaw') {
    return {
      type: 'openclaw',
      args: {},
      rawInput: trimmed,
    };
  }

  return null;
}

function parseScheduleCreate(input: string): ScheduleCommand {
  // Format: every <interval> <message>
  // Format: at <time> <message>
  // Format: cron <expr> <message>

  const parts = input.split(/\s+/);
  const type = parts[0];

  let schedule: ScheduleConfig;
  let messageStartIndex = 1;

  switch (type) {
    case 'every': {
      const interval = parseInterval(parts[1]);
      if (!interval) {
        throw new Error(`Invalid interval: ${parts[1]}`);
      }
      schedule = { type: 'every', intervalMs: interval };
      messageStartIndex = 2;
      break;
    }

    case 'at': {
      const timestamp = parseTimestamp(parts[1]);
      if (!timestamp) {
        throw new Error(`Invalid time: ${parts[1]}`);
      }
      schedule = { type: 'at', timestamp };
      messageStartIndex = parts.slice(1, 3).join(' ').split(/\s+/).length + 1;
      break;
    }

    case 'cron': {
      if (!parts[1]) {
        throw new Error('Cron expression required');
      }
      schedule = { type: 'cron', expression: parts[1] };
      messageStartIndex = 2;
      break;
    }

    default:
      throw new Error(`Unknown schedule type: ${type}`);
  }

  const message = parts.slice(messageStartIndex).join(' ').trim();
  if (!message) {
    throw new Error('Message is required');
  }

  return {
    type: 'create',
    args: { schedule, message },
    rawInput: input,
  };
}

function parseInterval(str: string): number | null {
  const match = str.match(/^(\d+)([smhd])$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

function parseTimestamp(str: string): number | null {
  const now = Date.now();

  // Relative time: "in 5m", "in 1h"
  const relativeMatch = str.match(/^in\s+(\d+)([smhd])$/i);
  if (relativeMatch) {
    const interval = parseInterval(relativeMatch[1] + relativeMatch[2]);
    return interval ? now + interval : null;
  }

  // ISO date-time
  const parsed = Date.parse(str);
  return Number.isFinite(parsed) ? parsed : null;
}

// ── Command Handler ──

export async function handleScheduleCommand(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  command: ScheduleCommand,
): Promise<OutboundMessage | null> {
  const store = getScheduledTasksStore();

  try {
    switch (command.type) {
      case 'create': {
        const { schedule, message } = command.args as { schedule: ScheduleConfig; message: string };

        const task = store.create({
          schedule,
          message,
          channelId: `${adapter.channelType}:${address.chatId}`,
          channelType: adapter.channelType,
          chatId: address.chatId,
          createdBy: address.userId || address.chatId,
        });

        const nextRun = task.nextRunAt ? new Date(task.nextRunAt).toLocaleString('zh-CN') : 'N/A';

        return {
          address,
          text: `✅ Task created\n\nID: ${task.id}\nSchedule: ${describeSchedule(task.schedule)}\nNext run: ${nextRun}`,
          parseMode: 'HTML',
        };
      }

      case 'list': {
        const { status } = command.args as { status?: string };
        const tasks = store.list({ channelType: adapter.channelType, chatId: address.chatId, status: status as TaskStatus });
        const stats = store.getStats();

        if (tasks.length === 0) {
          return {
            address,
            text: `📋 No tasks found\n\nUse /schedule to create a task`,
            parseMode: 'HTML',
          };
        }

        const lines = [`📋 Tasks (${tasks.length} total)`, ''];

        for (const task of tasks) {
          const statusIcon = task.status === 'active' ? '🟢' : task.status === 'paused' ? '⏸️' : '🔴';
          const shortId = task.id.slice(0, 12);
          const scheduleDesc = describeSchedule(task.schedule);
          const nextRun = task.nextRunAt ? new Date(task.nextRunAt).toLocaleString('zh-CN') : 'N/A';

          lines.push(`${statusIcon} <code>${shortId}</code>`);
          lines.push(`${scheduleDesc}`);
          lines.push(`Next: ${nextRun}`);
          lines.push(`<em>${task.message.slice(0, 50)}${task.message.length > 50 ? '...' : ''}</em>`);
          lines.push('');
        }

        return {
          address,
          text: lines.join('\n'),
          parseMode: 'HTML',
        };
      }

      case 'delete': {
        const { id } = command.args as { id: string };

        const task = store.get(id);
        if (!task) {
          return {
            address,
            text: `❌ Task not found: ${id}`,
            parseMode: 'HTML',
          };
        }

        store.delete(id);
        return {
          address,
          text: `✅ Task deleted`,
          parseMode: 'HTML',
        };
      }

      case 'pause': {
        const { id } = command.args as { id: string };

        const task = store.get(id);
        if (!task) {
          return {
            address,
            text: `❌ Task not found: ${id}`,
            parseMode: 'HTML',
          };
        }

        store.update(id, { status: 'paused' });
        return {
          address,
          text: `⏸️ Task paused`,
          parseMode: 'HTML',
        };
      }

      case 'resume': {
        const { id } = command.args as { id: string };

        const task = store.get(id);
        if (!task) {
          return {
            address,
            text: `❌ Task not found: ${id}`,
            parseMode: 'HTML',
          };
        }

        store.update(id, { status: 'active' });
        return {
          address,
          text: `▶️ Task resumed`,
          parseMode: 'HTML',
        };
      }

      case 'info': {
        const { id } = command.args as { id: string };

        const task = store.get(id);
        if (!task) {
          return {
            address,
            text: `❌ Task not found: ${id}`,
            parseMode: 'HTML',
          };
        }

        const statusIcon = task.status === 'active' ? '🟢' : task.status === 'paused' ? '⏸️' : '🔴';
        const statusText = task.status === 'active' ? 'Active' : task.status === 'paused' ? 'Paused' : 'Error';

        const lines = [
          `📋 Task Details`,
          '',
          `${statusIcon} Status: <b>${statusText}</b>`,
          `ID: <code>${task.id}</code>`,
          `Message: ${task.message}`,
          `Schedule: ${describeSchedule(task.schedule)}`,
          `Runs: ${task.runCount}`,
          `Errors: ${task.errorCount}`,
          `Created: ${new Date(task.createdAt).toLocaleString('zh-CN')}`,
        ];

        if (task.lastError) {
          lines.push(`Last Error: ${task.lastError}`);
        }

        return {
          address,
          text: lines.join('\n'),
          parseMode: 'HTML',
        };
      }

      case 'openclaw': {
        // Perform OpenClaw health check
        const result = await checkOpenClawHealth();
        return {
          address,
          text: formatHealthMessage(result),
          parseMode: 'HTML',
        };
      }

      default:
        return null;
    }
  } catch (err) {
    return {
      address,
      text: `❌ Error: ${escapeHtml(err instanceof Error ? err.message : String(err))}`,
      parseMode: 'HTML',
    };
  }
}

// ── Callback Handler ──

/**
 * Handle a schedule-related callback from an inline button press.
 * Returns true if the callback was recognized and handled.
 */
export function handleScheduleCallback(
  callbackData: string,
  callbackChatId: string,
  adapter: BaseChannelAdapter,
): { handled: boolean; response?: string } {
  // Parse callback data: task_action:taskId
  const parts = callbackData.split(':');
  if (parts.length < 2 || parts[0] !== 'task') return { handled: false };

  const action = parts[1];
  const taskId = parts.slice(2).join(':');

  const store = getScheduledTasksStore();
  const task = store.get(taskId);

  if (!task) {
    return { handled: false };
  }

  // Security: verify the callback came from the same chat
  if (task.chatId !== callbackChatId) {
    console.warn(`[schedule-broker] Chat ID mismatch for task ${taskId}`);
    return { handled: false };
  }

  switch (action) {
    case 'pause': {
      store.update(taskId, { status: 'paused' });
      return { handled: true, response: '⏸️ Task paused' };
    }

    case 'resume': {
      store.update(taskId, { status: 'active' });
      return { handled: true, response: '▶️ Task resumed' };
    }

    case 'delete': {
      store.delete(taskId);
      return { handled: true, response: '🗑️ Task deleted' };
    }

    case 'info': {
      // Just acknowledge, don't delete
      return { handled: true };
    }

    default:
      return { handled: false };
  }
}

// ── Send Task List with Buttons ──

export async function sendTaskList(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  page = 0,
  perPage = 5,
): Promise<void> {
  const store = getScheduledTasksStore();
  const tasks = store.list({ channelType: adapter.channelType, chatId: address.chatId });
  const stats = store.getStats();

  if (tasks.length === 0) {
    await deliver(adapter, {
      address,
      text: `📋 No tasks found\n\nUse /schedule to create a task`,
      parseMode: 'plain',
    });
    return;
  }

  const start = page * perPage;
  const end = start + perPage;
  const pageTasks = tasks.slice(start, end);
  const totalPages = Math.ceil(tasks.length / perPage);

  const lines = [
    `📋 Tasks (${tasks.length} total) · Page ${page + 1}/${totalPages}`,
    '',
  ];

  const buttons: Array<Array<{ text: string; callbackData: string }>> = [];

  for (const task of pageTasks) {
    const statusIcon = task.status === 'active' ? '🟢' : task.status === 'paused' ? '⏸️' : '🔴';
    const shortId = task.id.slice(0, 8);
    const scheduleDesc = describeSchedule(task.schedule);

    lines.push(`${statusIcon} <code>${shortId}</code>`);
    lines.push(`${scheduleDesc}`);
    lines.push(`<em>${task.message.slice(0, 30)}${task.message.length > 30 ? '...' : ''}</em>`);
    lines.push('');

    // Add action buttons for this task
    const row: { text: string; callbackData: string }[] = [];

    if (task.status === 'active') {
      row.push({ text: '⏸️', callbackData: `task:pause:${task.id}` });
    } else if (task.status === 'paused') {
      row.push({ text: '▶️', callbackData: `task:resume:${task.id}` });
    }

    row.push(
      { text: 'ℹ️', callbackData: `task:info:${task.id}` },
      { text: '🗑️', callbackData: `task:delete:${task.id}` },
    );

    buttons.push(row);
  }

  // Add pagination buttons if needed
  if (totalPages > 1) {
    const paginationRow: { text: string; callbackData: string }[] = [];

    if (page > 0) {
      paginationRow.push({ text: '⬅️', callbackData: `tasks:page:${page - 1}` });
    }

    paginationRow.push({ text: '🔄', callbackData: 'tasks:refresh' });

    if (page < totalPages - 1) {
      paginationRow.push({ text: '➡️', callbackData: `tasks:page:${page + 1}` });
    }

    buttons.push(paginationRow);
  }

  // Add "Create new task" button
  buttons.push([{ text: '➕ New Task', callbackData: 'tasks:create_help' }]);

  await deliver(adapter, {
    address,
    text: lines.join('\n'),
    parseMode: 'HTML',
    inlineButtons: buttons,
  });
}

// ── Helper ──

function describeSchedule(schedule: ScheduleConfig): string {
  switch (schedule.type) {
    case 'every':
      const interval = schedule.intervalMs;
      if (interval < 60 * 1000) return `Every ${interval / 1000}s`;
      if (interval < 60 * 60 * 1000) return `Every ${interval / (60 * 1000)}m`;
      if (interval < 24 * 60 * 60 * 1000) return `Every ${interval / (60 * 60 * 1000)}h`;
      return `Every ${interval / (24 * 60 * 60 * 1000)}d`;

    case 'at':
      return new Date(schedule.timestamp).toLocaleString('zh-CN');

    case 'cron':
      return `Cron: ${schedule.expression}`;

    default:
      return 'Unknown';
  }
}
