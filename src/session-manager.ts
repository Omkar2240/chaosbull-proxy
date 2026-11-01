import { PlaywrightBrowserController } from './browser-controller.js';
import { createHmac } from 'node:crypto';
import type { WebSocket } from 'ws';

export interface BrowserSession {
  id: string; // testRunId
  userId: string;
  controller: PlaywrightBrowserController;
  targetUrl: string;
  status: 'starting' | 'live' | 'navigating' | 'idle' | 'closed';
  createdAt: number;
  lastActive: number;
  subscribers: Set<WebSocket>;
  isExecuting: boolean;
  lastFrameBase64?: string;
  lastMetadata?: any;
  instructionQueue: Array<{
    id: string;
    instructions: string;
    resolve: (val: any) => void;
    reject: (err: any) => void;
  }>;
}

const sessions = new Map<string, BrowserSession>();

export function generateStreamTicket(runId: string, userId: string, secret: string): string {
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 min expiry
  const payload = `${runId}:${userId}:${expiresAt}`;
  const hmac = createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}:${hmac}`).toString('base64url');
}

export function verifyStreamTicket(
  ticket: string,
  runId: string,
  secret: string
): { valid: boolean; userId?: string; error?: string } {
  try {
    const raw = Buffer.from(ticket, 'base64url').toString('utf8');
    const [ticketRunId, userId, expiresAtStr, signature] = raw.split(':');

    if (ticketRunId !== runId) {
      return { valid: false, error: 'Ticket runId mismatch' };
    }

    const expiresAt = parseInt(expiresAtStr, 10);
    if (isNaN(expiresAt) || Date.now() > expiresAt) {
      return { valid: false, error: 'Ticket expired' };
    }

    const expectedSignature = createHmac('sha256', secret)
      .update(`${ticketRunId}:${userId}:${expiresAtStr}`)
      .digest('hex');

    if (signature !== expectedSignature) {
      return { valid: false, error: 'Invalid ticket signature' };
    }

    return { valid: true, userId };
  } catch {
    return { valid: false, error: 'Malformed ticket' };
  }
}

export class BrowserSessionManager {
  static async getOrCreateSession(
    runId: string,
    userId: string,
    targetUrl: string
  ): Promise<BrowserSession> {
    const existing = sessions.get(runId);
    if (existing && existing.status !== 'closed') {
      existing.lastActive = Date.now();
      return existing;
    }

    const controller = new PlaywrightBrowserController();
    await controller.initialize();

    const session: BrowserSession = {
      id: runId,
      userId,
      controller,
      targetUrl,
      status: 'starting',
      createdAt: Date.now(),
      lastActive: Date.now(),
      subscribers: new Set(),
      isExecuting: false,
      instructionQueue: [],
    };

    sessions.set(runId, session);

    // Start screencast forwarding
    await controller.startScreencast(({ data, metadata }) => {
      this.broadcastFrame(runId, data, metadata);
    });

    // Auto-navigate to targetUrl to initiate DOM render and screencast frames
    if (targetUrl && targetUrl !== 'about:blank') {
      console.log(`[SessionManager] Navigating new session ${runId} to: ${targetUrl}...`);
      try {
        await controller.navigate(targetUrl);
      } catch (navErr) {
        console.error(`[SessionManager] Initial navigation to ${targetUrl} failed:`, navErr);
      }
    }

    session.status = 'live';
    this.broadcastState(runId, {
      type: 'BROWSER_STATUS',
      status: 'live',
      url: controller.getUrl(),
      title: controller.getTitle(),
    });

    return session;
  }

  static getSession(runId: string): BrowserSession | undefined {
    return sessions.get(runId);
  }

  static async addSubscriber(runId: string, ws: WebSocket): Promise<void> {
    const session = sessions.get(runId);
    if (!session) {
      console.warn(
        `[SessionManager] addSubscriber: No active session found for runId: ${runId}. Current active sessions: [${Array.from(sessions.keys()).join(', ')}]`
      );
      try {
        ws.send(
          JSON.stringify({
            type: 'SESSION_WAITING',
            runId,
            status: 'waiting',
            message: 'Browser session has not launched yet. Click "Launch Browser" or send an instruction to launch.',
          })
        );
      } catch {}
      return;
    }

    session.subscribers.add(ws);
    session.lastActive = Date.now();
    console.log(
      `[SessionManager] addSubscriber: Client joined runId ${runId}. Subscribers: ${session.subscribers.size}, status: ${session.status}, hasCachedFrame: ${Boolean(session.lastFrameBase64)}`
    );

    // Send initial status and viewport metadata
    try {
      ws.send(
        JSON.stringify({
          type: 'SESSION_CONNECTED',
          runId,
          status: session.status,
          url: session.controller.getUrl(),
          title: session.controller.getTitle(),
          viewport: { width: 1280, height: 720 },
        })
      );

      // Immediate keyframe playback if available
      if (session.lastFrameBase64) {
        ws.send(
          JSON.stringify({
            type: 'FRAME',
            data: session.lastFrameBase64,
            metadata: session.lastMetadata,
            timestamp: Date.now(),
            url: session.controller.getUrl(),
            title: session.controller.getTitle(),
          })
        );
      } else {
        // Force immediate capture so the client never waits for screencast event
        session.controller.captureImmediateFrame().then((b64) => {
          if (b64 && ws.readyState === ws.OPEN) {
            session.lastFrameBase64 = b64;
            ws.send(
              JSON.stringify({
                type: 'FRAME',
                data: b64,
                timestamp: Date.now(),
                url: session.controller.getUrl(),
                title: session.controller.getTitle(),
              })
            );
          }
        }).catch(() => {});
      }
    } catch (err) {
      console.error('[SessionManager] Failed to send initial handshake to subscriber:', err);
    }
  }

  static removeSubscriber(runId: string, ws: WebSocket): void {
    const session = sessions.get(runId);
    if (session) {
      session.subscribers.delete(ws);
      console.log(`[SessionManager] removeSubscriber: Client left runId ${runId}. Remaining subscribers: ${session.subscribers.size}`);
    }
  }

  static broadcastFrame(runId: string, frameBase64: string, metadata: any): void {
    const session = sessions.get(runId);
    if (!session) return;

    session.lastFrameBase64 = frameBase64;
    session.lastMetadata = metadata;

    (session as any)._frameCount = ((session as any)._frameCount || 0) + 1;
    if ((session as any)._frameCount % 30 === 1) {
      console.log(
        `[SessionManager] broadcastFrame #${(session as any)._frameCount} for run ${runId} (${Math.round(frameBase64.length / 1024)} KB) to ${session.subscribers.size} client(s)`
      );
    }

    if (session.subscribers.size === 0) return;

    const payload = JSON.stringify({
      type: 'FRAME',
      data: frameBase64,
      metadata,
      timestamp: Date.now(),
      url: session.controller.getUrl(),
      title: session.controller.getTitle(),
    });

    for (const client of session.subscribers) {
      if (client.readyState === 1) { // OPEN
        try {
          client.send(payload);
        } catch {}
      }
    }
  }

  static broadcastState(runId: string, state: Record<string, unknown>): void {
    const session = sessions.get(runId);
    if (!session || session.subscribers.size === 0) return;

    const payload = JSON.stringify({
      ...state,
      runId,
      timestamp: Date.now(),
    });

    for (const client of session.subscribers) {
      if (client.readyState === 1) {
        try {
          client.send(payload);
        } catch {}
      }
    }
  }

  static async closeSession(runId: string): Promise<void> {
    const session = sessions.get(runId);
    if (!session) return;

    session.status = 'closed';
    this.broadcastState(runId, { type: 'SESSION_CLOSED' });

    for (const client of session.subscribers) {
      try {
        client.close(1000, 'Session completed');
      } catch {}
    }
    session.subscribers.clear();

    await session.controller.close();
    sessions.delete(runId);
  }

  static async cleanupIdleSessions(maxIdleMs = 10 * 60 * 1000): Promise<void> {
    const now = Date.now();
    for (const [id, session] of sessions.entries()) {
      if (now - session.lastActive > maxIdleMs && session.subscribers.size === 0) {
        await this.closeSession(id);
      }
    }
  }
}
