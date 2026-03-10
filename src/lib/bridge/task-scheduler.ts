/**
 * Task Scheduler
 *
 * Polls for due tasks and executes them by sending messages to the IM channel.
 * Runs in the background and checks for due tasks every 30 seconds.
 *
 * This is a simplified scheduler that works with the claude-to-im bridge.
 * For tasks that require Claude Code's native /loop functionality,
 * users should use the /loop command directly in an active session.
 */

import { getScheduledTasksStore, type ScheduledTask } from './scheduled-tasks-store.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import type { OutboundMessage, ChannelAddress } from './types.js';
import { deliver } from './delivery-layer.js';

// Scheduler state
let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
const CHECK_INTERVAL_MS = 30 * 1000; // Check every 30 seconds

// ── Start/Stop Scheduler ──

/**
 * Start the task scheduler. Begins polling for due tasks.
 */
export function startTaskScheduler(adapter: BaseChannelAdapter): void {
  if (isRunning) {
    console.warn('[task-scheduler] Scheduler already running');
    return;
  }

  isRunning = true;
  console.log('[task-scheduler] Starting task scheduler...');

  // Run once immediately
  processDueTasks(adapter).catch(err => {
    console.error('[task-scheduler] Error processing due tasks:', err);
  });

  // Then run on interval
  schedulerInterval = setInterval(() => {
    processDueTasks(adapter).catch(err => {
      console.error('[task-scheduler] Error processing due tasks:', err);
    });
  }, CHECK_INTERVAL_MS);
}

/**
 * Stop the task scheduler.
 */
export function stopTaskScheduler(): void {
  if (!isRunning) {
    return;
  }

  isRunning = false;
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  console.log('[task-scheduler] Task scheduler stopped');
}

/**
 * Check if the scheduler is running.
 */
export function isSchedulerRunning(): boolean {
  return isRunning;
}

// ── Task Execution ──

/**
 * Process all due tasks.
 */
async function processDueTasks(adapter: BaseChannelAdapter): Promise<void> {
  const store = getScheduledTasksStore();
  const dueTasks = store.getDueTasks();

  if (dueTasks.length === 0) {
    return;
  }

  console.log(`[task-scheduler] Found ${dueTasks.length} due task(s)`);

  for (const task of dueTasks) {
    await executeTask(adapter, task);
  }
}

/**
 * Execute a single task by sending its message to the configured channel.
 */
async function executeTask(adapter: BaseChannelAdapter, task: ScheduledTask): Promise<void> {
  const store = getScheduledTasksStore();

  console.log(`[task-scheduler] Executing task ${task.id.slice(0, 8)}...`);

  try {
    // Create the channel address
    const address: ChannelAddress = {
      chatId: task.chatId,
      userId: task.createdBy,
      channelType: task.channelType,
    };

    // Create the message
    const message: OutboundMessage = {
      address,
      text: `⏰ Scheduled Task: ${task.message}`,
      parseMode: 'HTML',
    };

    // Send the message
    await deliver(adapter, message);

    // Record successful execution
    store.recordRun(task.id, true);

    console.log(`[task-scheduler] Task ${task.id.slice(0, 8)} executed successfully`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[task-scheduler] Error executing task ${task.id.slice(0, 8)}:`, err);

    // Record failed execution
    store.recordRun(task.id, false, errorMsg);
  }
}

// ── Scheduler Status ──

/**
 * Get scheduler status information.
 */
export function getSchedulerStatus(): {
  running: boolean;
  checkInterval: number;
  nextCheck?: Date;
} {
  return {
    running: isRunning,
    checkInterval: CHECK_INTERVAL_MS,
  };
}

// ── Manual Trigger ──

/**
 * Manually trigger a check for due tasks (useful for testing).
 */
export async function triggerTaskCheck(adapter: BaseChannelAdapter): Promise<number> {
  const store = getScheduledTasksStore();
  const dueTasks = store.getDueTasks();

  if (dueTasks.length === 0) {
    return 0;
  }

  for (const task of dueTasks) {
    await executeTask(adapter, task);
  }

  return dueTasks.length;
}
