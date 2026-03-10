/**
 * Scheduled Tasks Store
 *
 * Manages persistent storage for scheduled/cron tasks.
 * Stores tasks in ~/.claude-to-im/data/scheduled-tasks.json
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getBridgeContext } from './context.js';
import { parseCron, getNextCronTime, type CronSchedule } from './cron-parser.js';

const DATA_DIR = path.join(process.env.HOME || '', '.claude-to-im', 'data');
const TASKS_FILE = path.join(DATA_DIR, 'scheduled-tasks.json');

// ── Type Definitions ──

export type ScheduleType = 'every' | 'at' | 'cron';

export type ScheduleConfig =
  | { type: 'every'; intervalMs: number }
  | { type: 'at'; timestamp: number }
  | { type: 'cron'; expression: string };

export type TaskStatus = 'active' | 'paused' | 'completed' | 'error';

export interface ScheduledTask {
  id: string;
  name?: string;
  status: TaskStatus;
  schedule: ScheduleConfig;
  message: string;
  channelId: string;        // e.g., "telegram:123456789"
  channelType: string;      // "telegram", "discord", etc.
  chatId: string;           // The actual chat ID
  createdBy: string;        // User ID who created the task
  createdAt: string;        // ISO timestamp
  updatedAt: string;        // ISO timestamp
  lastRunAt?: string;       // ISO timestamp
  nextRunAt?: string;       // ISO timestamp
  runCount: number;         // Number of times executed
  errorCount: number;       // Consecutive errors
  lastError?: string;       // Last error message
}

export interface TaskCreateInput {
  name?: string;
  schedule: ScheduleConfig;
  message: string;
  channelId: string;
  channelType: string;
  chatId: string;
  createdBy: string;
}

// ── Helpers ──

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

// ── Store Class ──

export class ScheduledTasksStore {
  private tasks: Map<string, ScheduledTask> = new Map();

  constructor() {
    ensureDir(DATA_DIR);
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(TASKS_FILE, 'utf-8');
      const data = JSON.parse(raw) as Record<string, ScheduledTask>;
      for (const [id, task] of Object.entries(data)) {
        this.tasks.set(id, task);
      }
    } catch {
      // File doesn't exist or is invalid - start fresh
      this.tasks.clear();
    }
  }

  private persist(): void {
    const data = Object.fromEntries(this.tasks);
    atomicWrite(TASKS_FILE, JSON.stringify(data, null, 2));
  }

  // ── CRUD Operations ──

  create(input: TaskCreateInput): ScheduledTask {
    const task: ScheduledTask = {
      id: uuid(),
      name: input.name,
      status: 'active',
      schedule: input.schedule,
      message: input.message,
      channelId: input.channelId,
      channelType: input.channelType,
      chatId: input.chatId,
      createdBy: input.createdBy,
      createdAt: now(),
      updatedAt: now(),
      runCount: 0,
      errorCount: 0,
    };

    // Calculate next run time
    task.nextRunAt = this.calculateNextRun(task).toISOString();

    this.tasks.set(task.id, task);
    this.persist();
    return task;
  }

  get(id: string): ScheduledTask | null {
    return this.tasks.get(id) || null;
  }

  list(options?: { status?: TaskStatus; channelType?: string; chatId?: string }): ScheduledTask[] {
    let tasks = Array.from(this.tasks.values());

    if (options?.status) {
      tasks = tasks.filter(t => t.status === options.status);
    }

    if (options?.channelType) {
      tasks = tasks.filter(t => t.channelType === options.channelType);
    }

    if (options?.chatId) {
      tasks = tasks.filter(t => t.chatId === options.chatId);
    }

    // Sort by next run time, then created time
    tasks.sort((a, b) => {
      const aNext = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Infinity;
      const bNext = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Infinity;
      return aNext - bNext || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    return tasks;
  }

  update(id: string, patch: Partial<Omit<ScheduledTask, 'id'>>): ScheduledTask | null {
    const task = this.tasks.get(id);
    if (!task) return null;

    if (patch.name !== undefined) task.name = patch.name;
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.schedule !== undefined) {
      task.schedule = patch.schedule;
      task.nextRunAt = this.calculateNextRun(task).toISOString();
    }
    if (patch.message !== undefined) task.message = patch.message;
    if (patch.lastRunAt !== undefined) task.lastRunAt = patch.lastRunAt;
    if (patch.lastError !== undefined) task.lastError = patch.lastError;
    if (patch.runCount !== undefined) task.runCount = patch.runCount;
    if (patch.errorCount !== undefined) task.errorCount = patch.errorCount;

    task.updatedAt = now();
    this.tasks.set(id, task);
    this.persist();
    return task;
  }

  delete(id: string): boolean {
    const deleted = this.tasks.delete(id);
    if (deleted) {
      this.persist();
    }
    return deleted;
  }

  // ── Execution Tracking ──

  recordRun(id: string, success: boolean, error?: string): void {
    const task = this.tasks.get(id);
    if (!task) return;

    task.lastRunAt = now();
    task.runCount++;

    if (success) {
      task.errorCount = 0;
      task.lastError = undefined;
      task.status = 'active';
    } else {
      task.errorCount++;
      task.lastError = error;

      // Disable after 5 consecutive errors
      if (task.errorCount >= 5) {
        task.status = 'error';
      }
    }

    // Calculate next run time for recurring tasks
    if (task.status !== 'error' && task.schedule.type !== 'at') {
      task.nextRunAt = this.calculateNextRun(task).toISOString();
    } else {
      task.nextRunAt = undefined;
    }

    task.updatedAt = now();
    this.persist();
  }

  // ── Due Tasks ──

  getDueTasks(before?: Date): ScheduledTask[] {
    const cutoff = before || new Date();
    const cutoffMs = cutoff.getTime();

    return this.list({ status: 'active' }).filter(task => {
      if (!task.nextRunAt) return false;
      return new Date(task.nextRunAt).getTime() <= cutoffMs;
    });
  }

  // ── Helpers ──

  private calculateNextRun(task: ScheduledTask): Date {
    const nowDate = new Date();

    switch (task.schedule.type) {
      case 'every':
        return new Date(nowDate.getTime() + task.schedule.intervalMs);

      case 'at':
        return new Date(task.schedule.timestamp);

      case 'cron': {
        // Parse cron expression and get next run time
        try {
          const schedule = parseCron(task.schedule.expression);
          const nextTime = getNextCronTime(schedule, nowDate);
          return nextTime || new Date(nowDate.getTime() + 60 * 60 * 1000);
        } catch (err) {
          console.error(`[scheduled-tasks-store] Failed to parse cron expression: ${task.schedule.expression}`, err);
          // Fallback to hourly if cron parsing fails
          return new Date(nowDate.getTime() + 60 * 60 * 1000);
        }
      }

      default:
        return new Date(nowDate.getTime() + 60 * 60 * 1000);
    }
  }

  // ── Statistics ──

  getStats(): { total: number; active: number; paused: number; error: number } {
    const tasks = Array.from(this.tasks.values());
    return {
      total: tasks.length,
      active: tasks.filter(t => t.status === 'active').length,
      paused: tasks.filter(t => t.status === 'paused').length,
      error: tasks.filter(t => t.status === 'error').length,
    };
  }
}

// ── Singleton Store Instance ──

let storeInstance: ScheduledTasksStore | null = null;

export function getScheduledTasksStore(): ScheduledTasksStore {
  if (!storeInstance) {
    storeInstance = new ScheduledTasksStore();
  }
  return storeInstance;
}
