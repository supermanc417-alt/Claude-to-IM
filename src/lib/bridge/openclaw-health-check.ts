/**
 * OpenClaw Health Check Module
 *
 * Checks if OpenClaw gateway is running and healthy.
 */

const HEALTH_CHECK_URL = 'https://api.openclaw.org/health';
const HEALTH_CHECK_TIMEOUT = 10000; // 10 seconds

interface HealthCheckResult {
  healthy: boolean;
  status?: string;
  error?: string;
  responseTime?: number;
}

export async function checkOpenClawHealth(): Promise<HealthCheckResult> {
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);

    const response = await fetch(HEALTH_CHECK_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'claude-to-im-health-check/1.0',
      },
    });

    clearTimeout(timeoutId);
    const responseTime = Date.now() - startTime;

    if (response.ok) {
      const data = await response.json() as { status?: string };
      return {
        healthy: true,
        status: data.status,
        responseTime,
      };
    } else {
      return {
        healthy: false,
        error: `HTTP ${response.status}`,
        responseTime,
      };
    }
  } catch (err) {
    const responseTime = Date.now() - startTime;
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        healthy: false,
        error: 'timeout',
        responseTime,
      };
    }
    return {
      healthy: false,
      error: err instanceof Error ? err.message : String(err),
      responseTime,
    };
  }
}

export function formatHealthMessage(result: HealthCheckResult): string {
  if (result.healthy) {
    const status = result.status ? ` (${result.status})` : '';
    return `✅ OpenClaw 正常运行 ${status} (${result.responseTime}ms)`;
  } else {
    return `❌ OpenClaw 不可用：${result.error} (${result.responseTime}ms)`;
  }
}
