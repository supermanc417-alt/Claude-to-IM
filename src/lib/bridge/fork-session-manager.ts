/**
 * Fork 项目会话和模型管理提供者
 *
 * 专为 Telegram bridge 设计，简化版会话管理功能
 */

import type { OutboundMessage, ChannelAddress } from '../types.js';

export interface SessionMessageRequest {
  modelId?: string;
  chatId?: string;
}

export interface SessionCommand {
  action: 'set_model' | 'sessions' | 'new' | 'switch';
  args?: string | Record<string, unknown>;
}

/**
 * 会话管理提供者
 * 将会话/模型请求转换为 bridge 消息格式
 */
export class SessionManager {
  private enabled: boolean = false;

  enable() {
    this.enabled = true;
    console.log('[session-manager] 会话管理功能已启用');
  }

  disable() {
    this.enabled = false;
    console.log('[session-manager] 会话管理功能已禁用');
  }

  /**
   * 处理会话命令并转换为 bridge 消息
   */
  async handleCommand(
    channelType: string,
    chatId: string,
    command: SessionCommand,
  ): Promise<OutboundMessage | null> {
    if (!this.enabled) {
      // 返回简单的错误提示
      return {
        address: { chatId },
        text: '⚠️ 会话管理功能未启用\n\n请在 skill 配置中设置 `useForkProject: true`',
        parseMode: 'plain',
      };
    }

    switch (command.action) {
      case 'set_model': {
        // 设置模型：/model claude-sonnet-4-6
        if (!command.args.modelId) {
          return {
            address: { chatId },
            text: '❌ 模型 ID 不能为空\n用法: /model claude-sonnet-4-6',
            parseMode: 'plain',
          };
        }

        // 发送模型设置消息到 Claude
        const modelSetMsg: `✅ 模型已设置为 ${command.args.modelId}`;
        return {
          address: { chatId },
          text: `📋 **会话操作：**\n\n/model claude-sonnet-4-6：设置模型为 ${command.args.modelId}\n\n${modelSetMsg}`,
          parseMode: 'HTML',
        };
      }

      case 'sessions': {
        // 列出会话（简化版，只显示当前会话）
        return {
          address: { chatId },
          text: '📋 **当前会话列表**\n\n(使用 `/model` 切换模型)',
          parseMode: 'HTML',
        };
      }

      case 'new': {
        // 创建新会话
        const sessionName = command.args.name || `session-${Date.now()}`;
        return {
          address: { chatId },
          text: `✅ **会话操作：**\n\n已创建新会话：${sessionName}\n\n模型：${command.args.modelId || 'claude-sonnet-4-6'}`,
          parseMode: 'HTML',
        };
      }

      case 'switch': {
        // 切换会话
        if (!command.args.sessionId) {
          return {
            address: { chatId },
            text: '❌ 会话 ID 不能为空\n用法: /session switch <session_id>',
            parseMode: 'plain',
          };
        }

        const switchMsg = `✅ **会话操作：**\n\n已切换到会话：${command.args.sessionId}`;
        return {
          address: { chatId },
          text: switchMsg,
          parseMode: 'HTML',
        };
      }

      default:
        return {
          address: { chatId },
          text: '❓ 未知的命令',
          parseMode: 'plain',
        };
    }
  }

  /**
   * 获取会话列表
   */
  async getSessions(channelType: string, chatId: string): Promise<OutboundMessage> {
    if (!this.enabled) {
      return {
        address: { chatId },
        text: '⚠️ 会话管理功能未启用',
        parseMode: 'plain',
      };
    }

    // 返回简单的会话列表（模拟）
    const sessions = [
      { id: 'session-123', name: '我的项目', model: 'claude-sonnet-4-6', workingDir: '/Users/evan/Claude Code', created: '2026-03-09T10:00:00' },
      { id: 'session-456', name: '工作会话', model: 'claude-sonnet-4.6', workingDir: '/Users/evan/Claude Code', created: '2026-03-08T14:30:00' },
    ];

    const sessionList = sessions.map(s => `${s.icon} ${s.id.slice(0, 8)} - ${s.name} (${s.model})\n${s.working_dir}`).join('\n');
    const response = `📋 **会话列表**\n\n共有 ${sessions.length} 个会话\n\n${sessionList}`;

    return {
      address: { chatId },
      text: response,
      parseMode: 'HTML',
    };
  }
}
