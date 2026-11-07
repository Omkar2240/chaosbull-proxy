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

export interface QueuedSessionItem {
  runId: string;
  userId: string;
  targetUrl: string;
  queuedAt: number;
}

export interface SessionStartResult {
  session: BrowserSession | null;
  status: 'live' | 'starting' | 'queued';
  isQueued: boolean;
  queuePosition: number;
  totalQueued: number;
  estimatedWaitSec: number;
  ticket?: string;
}

// Configurable maximum concurrent Playwright browser sessions (default: 3)
export const MAX_CONCURRENT_SESSIONS = parseInt(
  process.env.MAX_CONCURRENT_SESSIONS || '3',
  10
);

const sessions = new Map<string, BrowserSession>();
const activeSessionIds = new Set<string>();
const sessionQueue: QueuedSessionItem[] = [];
const pendingSubscribers = new Map<string, Set<WebSocket>>();

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
  /**
   * Concurrency-aware session request:
   * Launches immediately if capacity is available, or queues if active sessions >= MAX_CONCURRENT_SESSIONS.
   */
  static async requestOrCreateSession(
    runId: string,
    userId: string,
    targetUrl: string
  ): Promise<SessionStartResult> {
    const existing = sessions.get(runId);
    if (existing && existing.status !== 'closed') {
      existing.lastActive = Date.now();
      return {
        session: existing,
        status: existing.status as any,
        isQueued: false,
        queuePosition: 0,
        totalQueued: sessionQueue.length,
        estimatedWaitSec: 0,
      };
    }

    // Capacity Check
    if (activeSessionIds.size < MAX_CONCURRENT_SESSIONS) {
      console.log(
        `[ConcurrencyQueue] Capacity available (${activeSessionIds.size}/${MAX_CONCURRENT_SESSIONS} active). Spawning session for ${runId}...`
      );
      activeSessionIds.add(runId);
      const session = await this.createBrowserSession(runId, userId, targetUrl);
      return {
        session,
        status: 'live',
        isQueued: false,
        queuePosition: 0,
        totalQueued: sessionQueue.length,
        estimatedWaitSec: 0,
      };
    }

    // Concurrency Limit Reached -> Add to FIFO Queue
    let existingIndex = sessionQueue.findIndex((q) => q.runId === runId);
    if (existingIndex === -1) {
      sessionQueue.push({
        runId,
        userId,
        targetUrl,
        queuedAt: Date.now(),
      });
      existingIndex = sessionQueue.length - 1;
    }

    const position = existingIndex + 1;
    const estimatedWaitSec = position * 30;

    console.warn(
      `[ConcurrencyQueue] Capacity reached (${activeSessionIds.size}/${MAX_CONCURRENT_SESSIONS} active). RunId ${runId} queued at position #${position} (est. ~${estimatedWaitSec}s wait).`
    );

    this.broadcastState(runId, {
      type: 'SESSION_QUEUED',
      runId,
      status: 'queued',
      position,
      totalQueued: sessionQueue.length,
      estimatedWaitSec,
      message: `Server load high (${activeSessionIds.size}/${MAX_CONCURRENT_SESSIONS} active tests). Session queued at position #${position}.`,
    });

    return {
      session: null,
      status: 'queued',
      isQueued: true,
      queuePosition: position,
      totalQueued: sessionQueue.length,
      estimatedWaitSec,
    };
  }

  /**
   * Internal browser process boot and initial navigation.
   */
  private static async createBrowserSession(
    runId: string,
    userId: string,
    targetUrl: string
  ): Promise<BrowserSession> {
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

    // Attach any subscribers who connected while session was in queue
    const pending = pendingSubscribers.get(runId);
    if (pending) {
      for (const ws of pending) {
        session.subscribers.add(ws);
      }
      pendingSubscribers.delete(runId);
    }

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

  static getQueueStatus(runId: string) {
    const index = sessionQueue.findIndex((q) => q.runId === runId);
    const isQueued = index !== -1;
    const position = isQueued ? index + 1 : 0;
    return {
      isQueued,
      position,
      totalQueued: sessionQueue.length,
      activeCount: activeSessionIds.size,
      maxConcurrent: MAX_CONCURRENT_SESSIONS,
      estimatedWaitSec: position * 30,
    };
  }

  static async addSubscriber(runId: string, ws: WebSocket): Promise<void> {
    const session = sessions.get(runId);

    // If session is already created and active
    if (session) {
      session.subscribers.add(ws);
      session.lastActive = Date.now();
      console.log(
        `[SessionManager] addSubscriber: Client joined runId ${runId}. Subscribers: ${session.subscribers.size}, status: ${session.status}`
      );

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
        console.error('[SessionManager] Handshake error:', err);
      }
      return;
    }

    // If session is currently in queue
    const queueInfo = this.getQueueStatus(runId);
    if (queueInfo.isQueued) {
      let pending = pendingSubscribers.get(runId);
      if (!pending) {
        pending = new Set();
        pendingSubscribers.set(runId, pending);
      }
      pending.add(ws);

      try {
        ws.send(
          JSON.stringify({
            type: 'SESSION_QUEUED',
            runId,
            status: 'queued',
            position: queueInfo.position,
            totalQueued: queueInfo.totalQueued,
            estimatedWaitSec: queueInfo.estimatedWaitSec,
            activeCount: queueInfo.activeCount,
            maxConcurrent: queueInfo.maxConcurrent,
            message: `Server load high (${queueInfo.activeCount}/${queueInfo.maxConcurrent} active). You are #${queueInfo.position} in queue. Starting in ~${queueInfo.estimatedWaitSec}s...`,
          })
        );
      } catch {}
      return;
    }

    // Default standby message
    try {
      ws.send(
        JSON.stringify({
          type: 'SESSION_WAITING',
          runId,
          status: 'waiting',
          message: 'Browser session preparing to launch...',
        })
      );
    } catch {}
  }

  static removeSubscriber(runId: string, ws: WebSocket): void {
    const session = sessions.get(runId);
    if (session) {
      session.subscribers.delete(ws);
    }
    const pending = pendingSubscribers.get(runId);
    if (pending) {
      pending.delete(ws);
      if (pending.size === 0) pendingSubscribers.delete(runId);
    }
  }

  static broadcastFrame(runId: string, frameBase64: string, metadata: any): void {
    const session = sessions.get(runId);
    if (!session) return;

    session.lastFrameBase64 = frameBase64;
    session.lastMetadata = metadata;

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
    const payload = JSON.stringify({
      ...state,
      runId,
      timestamp: Date.now(),
    });

    // Send to active session subscribers
    const session = sessions.get(runId);
    if (session) {
      for (const client of session.subscribers) {
        if (client.readyState === 1) {
          try {
            client.send(payload);
          } catch {}
        }
      }
    }

    // Also send to pending queued subscribers
    const pending = pendingSubscribers.get(runId);
    if (pending) {
      for (const client of pending) {
        if (client.readyState === 1) {
          try {
            client.send(payload);
          } catch {}
        }
      }
    }
  }

  /**
   * Closes an active session or cancels a queued session, freeing up a concurrency slot and dequeuing the next user.
   */
  static async closeSession(runId: string): Promise<void> {
    const session = sessions.get(runId);
    if (session) {
      session.status = 'closed';
      this.broadcastState(runId, { type: 'SESSION_CLOSED' });

      for (const client of session.subscribers) {
        try {
          client.close(1000, 'Session completed');
        } catch {}
      }
      session.subscribers.clear();

      await session.controller.close().catch(() => {});
      sessions.delete(runId);
    }

    activeSessionIds.delete(runId);

    // If session was waiting in queue, remove it from queue
    const qIndex = sessionQueue.findIndex((q) => q.runId === runId);
    if (qIndex !== -1) {
      sessionQueue.splice(qIndex, 1);
      // Notify remaining queued sessions of their updated position
      sessionQueue.forEach((item, idx) => {
        const pos = idx + 1;
        this.broadcastState(item.runId, {
          type: 'SESSION_QUEUED',
          position: pos,
          totalQueued: sessionQueue.length,
          estimatedWaitSec: pos * 30,
          message: `Queue update: You moved up to #${pos} in line. Starting in ~${pos * 30}s...`,
        });
      });
    }

    // Clean up any pending subscribers for this runId
    const pending = pendingSubscribers.get(runId);
    if (pending) {
      for (const client of pending) {
        try {
          client.close(1000, 'Session cancelled or closed');
        } catch {}
      }
      pendingSubscribers.delete(runId);
    }

    // Immediately process next user in the concurrency queue
    this.processNextQueuedSession().catch((err) => {
      console.error('[ConcurrencyQueue] Error processing next queued session:', err);
    });
  }

  static getActiveCount(): number {
    return activeSessionIds.size;
  }

  static getQueueLength(): number {
    return sessionQueue.length;
  }

  /**
   * Backward-compatible alias for requestOrCreateSession
   */
  static async getOrCreateSession(
    runId: string,
    userId: string,
    targetUrl: string
  ): Promise<BrowserSession> {
    const result = await this.requestOrCreateSession(runId, userId, targetUrl);
    if (result.session) return result.session;
    throw new Error(
      `Session ${runId} is queued at position #${result.queuePosition}. Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached.`
    );
  }

  /**
   * Dequeues the next waiting session and boots its browser context.
   */
  private static async processNextQueuedSession(): Promise<void> {
    if (sessionQueue.length === 0 || activeSessionIds.size >= MAX_CONCURRENT_SESSIONS) {
      return;
    }

    const next = sessionQueue.shift();
    if (!next) return;

    console.log(
      `[ConcurrencyQueue] Dequeuing next session: ${next.runId}. Slots: ${activeSessionIds.size + 1}/${MAX_CONCURRENT_SESSIONS}`
    );

    activeSessionIds.add(next.runId);

    // Notify all remaining queued items of their updated position
    sessionQueue.forEach((item, idx) => {
      const pos = idx + 1;
      this.broadcastState(item.runId, {
        type: 'SESSION_QUEUED',
        position: pos,
        totalQueued: sessionQueue.length,
        estimatedWaitSec: pos * 30,
        message: `Queue update: You moved up to #${pos} in line. Starting in ~${pos * 30}s...`,
      });
    });

    try {
      this.broadcastState(next.runId, {
        type: 'SESSION_DEQUEUED',
        message: 'Your turn has arrived! Spawning live browser sandbox...',
      });
      await this.createBrowserSession(next.runId, next.userId, next.targetUrl);
    } catch (err) {
      console.error(`[ConcurrencyQueue] Failed to launch dequeued session ${next.runId}:`, err);
      activeSessionIds.delete(next.runId);
      // Try next
      this.processNextQueuedSession();
    }
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
