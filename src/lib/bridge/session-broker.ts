/**
 * Session Broker — handles session and model commands from IM channels.
 *
 * Provides commands for:
 * - Viewing and changing the current AI model
 * - Listing all sessions
 * - Creating new sessions
 * - Switching between sessions
 */

import type { OutboundMessage, ChannelAddress } from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';

// ── Available Models ──

export const AVAILABLE_MODELS = [
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', description: '最强模型，复杂任务' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: '平衡性能和速度' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', description: '快速响应，简单任务' },
] as const;

export type AvailableModelId = typeof AVAILABLE_MODELS[number]['id'];

// ── Command Parser ──

export interface SessionCommand {
  type: 'model' | 'sessions' | 'session';
  action: 'view' | 'set' | 'list' | 'new' | 'switch' | 'current';
  args: Record<string, unknown>;
  rawInput: string;
}

export function parseSessionCommand(input: string): SessionCommand | null {
  const trimmed = input.trim();

  // /model [model-id]
  if (trimmed.startsWith('/model')) {
    const rest = trimmed.slice('/model'.length).trim();
    return {
      type: 'model',
      action: rest ? 'set' : 'view',
      args: rest ? { modelId: rest } : {},
      rawInput: trimmed,
    };
  }

  // /sessions
  if (trimmed === '/sessions') {
    return {
      type: 'sessions',
      action: 'list',
      args: {},
      rawInput: trimmed,
    };
  }

  // /session new [name]
  if (trimmed.startsWith('/session new')) {
    const rest = trimmed.slice('/session new'.length).trim();
    return {
      type: 'session',
      action: 'new',
      args: { name: rest || undefined },
      rawInput: trimmed,
    };
  }

  // /session switch <id>
  if (trimmed.startsWith('/session switch ')) {
    const rest = trimmed.slice('/session switch '.length).trim();
    return {
      type: 'session',
      action: 'switch',
      args: { sessionId: rest },
      rawInput: trimmed,
    };
  }

  // /session current
  if (trimmed === '/session current') {
    return {
      type: 'session',
      action: 'current',
      args: {},
      rawInput: trimmed,
    };
  }

  return null;
}

// ── Command Handler ──

export async function handleSessionCommand(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  command: SessionCommand,
): Promise<OutboundMessage | null> {
  const { store } = getBridgeContext();

  try {
    switch (command.type) {
      case 'model':
        return await handleModelCommand(adapter, address, command);

      case 'sessions':
        return handleSessionsList(adapter, address);

      case 'session':
        return await handleSessionCommandAction(adapter, address, command);

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

// ── Model Commands ──

async function handleModelCommand(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  command: SessionCommand,
): Promise<OutboundMessage> {
  const { store } = getBridgeContext();

  if (command.action === 'view') {
    // Get current binding to see current model
    const binding = store.getChannelBinding(adapter.channelType, address.chatId);
    const currentModel = binding?.model || 'default';

    const lines = [
      '<b>🤖 AI Model</b>',
      '',
      `Current: <code>${escapeHtml(currentModel)}</code>`,
      '',
      '<b>Available Models:</b>',
    ];

    for (const model of AVAILABLE_MODELS) {
      const isCurrent = model.id === currentModel;
      const icon = isCurrent ? '🟢' : '⚪';
      lines.push(`${icon} <code>${model.id}</code> - ${model.name}`);
      lines.push(`   <em>${model.description}</em>`);
    }

    lines.push('');
    lines.push('Use <code>/model &lt;model-id&gt;</code> to switch');

    return {
      address,
      text: lines.join('\n'),
      parseMode: 'HTML',
    };
  }

  if (command.action === 'set') {
    const { modelId } = command.args as { modelId: string };

    // Validate model ID
    const validModel = AVAILABLE_MODELS.find(m => m.id === modelId);
    if (!validModel) {
      const modelList = AVAILABLE_MODELS.map(m => m.id).join(', ');
      return {
        address,
        text: `❌ Unknown model: ${escapeHtml(modelId)}\n\nAvailable: ${modelList}`,
        parseMode: 'HTML',
      };
    }

    // Update the binding
    const binding = store.getChannelBinding(adapter.channelType, address.chatId);
    if (binding) {
      store.updateChannelBinding(binding.id, { model: modelId });
    } else {
      // Create binding if it doesn't exist
      store.upsertChannelBinding({
        channelType: adapter.channelType,
        chatId: address.chatId,
        codepilotSessionId: '',
        workingDirectory: process.cwd(),
        model: modelId,
      });
    }

    return {
      address,
      text: `✅ Model changed to <b>${validModel.name}</b>\n\n<code>${modelId}</code>`,
      parseMode: 'HTML',
    };
  }

  return {
    address,
    text: '❓ Unknown model command',
    parseMode: 'HTML',
  };
}

// ── Sessions Commands ──

function handleSessionsList(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
): OutboundMessage {
  const { store } = getBridgeContext();

  // Get current binding
  const currentBinding = store.getChannelBinding(adapter.channelType, address.chatId);

  // Get all bindings for this channel
  const allBindings = store.listChannelBindings(adapter.channelType);

  if (allBindings.length === 0) {
    return {
      address,
      text: '📋 <b>No Sessions</b>\n\nUse <code>/session new</code> to create a session',
      parseMode: 'HTML',
    };
  }

  const lines = [
    `📋 <b>Sessions</b> (${allBindings.length} total)`,
    '',
  ];

  for (const binding of allBindings) {
    const isCurrent = currentBinding?.id === binding.id;
    const icon = isCurrent ? '🟢' : '⚪';
    const shortId = binding.codepilotSessionId.slice(0, 12);
    const model = binding.model || 'default';
    const dir = binding.workingDirectory?.split('/').pop() || '~';

    lines.push(`${icon} <code>${shortId}</code> - ${model}`);
    lines.push(`   📁 ${escapeHtml(dir)}`);

    if (isCurrent) {
      lines.push(`   <em>(current)</em>`);
    }
    lines.push('');
  }

  lines.push('Use <code>/session switch &lt;id&gt;</code> to switch');
  lines.push('Use <code>/session new</code> to create a session');

  return {
    address,
    text: lines.join('\n'),
    parseMode: 'HTML',
  };
}

async function handleSessionCommandAction(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  command: SessionCommand,
): Promise<OutboundMessage> {
  const { store } = getBridgeContext();

  switch (command.action) {
    case 'new': {
      const { name } = command.args as { name?: string };

      // Create a new session in the store
      const session = store.createSession(
        name || `session-${Date.now()}`,
        store.getSetting('bridge_default_model') || 'claude-opus-4-6',
        undefined,
        store.getSetting('bridge_default_work_dir') || process.cwd(),
        'code',
      );

      // Create binding for this channel
      store.upsertChannelBinding({
        channelType: adapter.channelType,
        chatId: address.chatId,
        codepilotSessionId: session.id,
        workingDirectory: session.working_directory,
        model: session.model,
      });

      return {
        address,
        text: `✅ <b>New Session Created</b>\n\nID: <code>${session.id.slice(0, 12)}</code>\nModel: ${session.model}\nDirectory: ${escapeHtml(session.working_directory)}`,
        parseMode: 'HTML',
      };
    }

    case 'switch': {
      const { sessionId } = command.args as { sessionId: string };

      // Find the session
      const session = store.getSession(sessionId);
      if (!session) {
        return {
          address,
          text: `❌ Session not found: ${escapeHtml(sessionId)}`,
          parseMode: 'HTML',
        };
      }

      // Update binding to point to this session
      const binding = store.getChannelBinding(adapter.channelType, address.chatId);
      if (binding) {
        store.updateChannelBinding(binding.id, {
          sdkSessionId: session.id,
          model: session.model,
        });
      } else {
        store.upsertChannelBinding({
          channelType: adapter.channelType,
          chatId: address.chatId,
          codepilotSessionId: session.id,
          workingDirectory: session.working_directory,
          model: session.model,
        });
      }

      return {
        address,
        text: `✅ <b>Switched to Session</b>\n\nID: <code>${session.id.slice(0, 12)}</code>\nModel: ${session.model}`,
        parseMode: 'HTML',
      };
    }

    case 'current': {
      const binding = store.getChannelBinding(adapter.channelType, address.chatId);

      if (!binding) {
        return {
          address,
          text: '📋 <b>Current Session</b>\n\nNo active session\n\nUse <code>/session new</code> to create a session',
          parseMode: 'HTML',
        };
      }

      const session = binding.sdkSessionId ? store.getSession(binding.sdkSessionId) : null;

      return {
        address,
        text: `📋 <b>Current Session</b>\n\nID: <code>${binding.codepilotSessionId.slice(0, 12)}</code>\nModel: ${binding.model || 'default'}\nDirectory: ${escapeHtml(binding.workingDirectory || '~')}`,
        parseMode: 'HTML',
      };
    }

    default:
      return {
        address,
        text: '❓ Unknown session command',
        parseMode: 'HTML',
      };
  }
}

// ── Send Sessions List with Buttons ──

export async function sendSessionsList(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
): Promise<void> {
  const { store } = getBridgeContext();

  // Get current binding
  const currentBinding = store.getChannelBinding(adapter.channelType, address.chatId);

  // Get all bindings for this channel
  const allBindings = store.listChannelBindings(adapter.channelType);

  if (allBindings.length === 0) {
    const { deliver } = await import('./delivery-layer.js');
    await deliver(adapter, {
      address,
      text: '📋 No Sessions\n\nUse /session new to create a session',
      parseMode: 'plain',
      inlineButtons: [[{ text: '➕ New Session', callbackData: 'session:new_help' }]],
    });
    return;
  }

  const lines = [
    `📋 Sessions (${allBindings.length} total)`,
    '',
  ];

  const buttons: Array<Array<{ text: string; callbackData: string }>> = [];

  for (const binding of allBindings) {
    const isCurrent = currentBinding?.id === binding.id;
    const icon = isCurrent ? '🟢' : '⚪';
    const shortId = binding.codepilotSessionId.slice(0, 8);
    const model = binding.model || 'default';
    const dir = binding.workingDirectory?.split('/').pop() || '~';

    lines.push(`${icon} <code>${shortId}</code> - ${model}`);
    lines.push(`   📁 ${escapeHtml(dir)}`);
    lines.push('');

    // Add action buttons for this session
    const row: { text: string; callbackData: string }[] = [];

    if (!isCurrent) {
      row.push({ text: '🔄', callbackData: `session:switch:${binding.codepilotSessionId}` });
    }

    row.push({ text: 'ℹ️', callbackData: `session:info:${binding.codepilotSessionId}` });

    buttons.push(row);
  }

  // Add "Create new session" button
  buttons.push([{ text: '➕ New Session', callbackData: 'session:new_help' }]);

  const { deliver } = await import('./delivery-layer.js');
  await deliver(adapter, {
    address,
    text: lines.join('\n'),
    parseMode: 'HTML',
    inlineButtons: buttons,
  });
}

// ── Callback Handler ──

export function handleSessionCallback(
  callbackData: string,
  callbackChatId: string,
  adapter: BaseChannelAdapter,
): { handled: boolean; response?: string } {
  // Parse callback data: session_action:sessionId
  const parts = callbackData.split(':');
  if (parts.length < 2 || parts[0] !== 'session') return { handled: false };

  const action = parts[1];

  switch (action) {
    case 'new_help':
      return {
        handled: true,
        response: '💡 To create a new session, use:\n\n/session new [name]',
      };

    case 'info': {
      const sessionId = parts.slice(2).join(':');
      const { store } = getBridgeContext();
      const session = store.getSession(sessionId);

      if (!session) {
        return { handled: false };
      }

      const lines = [
        '📋 Session Details',
        '',
        `ID: ${session.id.slice(0, 12)}`,
        `Model: ${session.model}`,
        `Directory: ${session.working_directory}`,
      ];

      return { handled: true, response: lines.join('\n') };
    }

    default:
      return { handled: false };
  }
}
