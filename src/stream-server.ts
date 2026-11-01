import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import { BrowserSessionManager, verifyStreamTicket } from './session-manager.js';

export function setupStreamWebSocketServer(httpServer: HttpServer, secretToken: string) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);

    if (url.pathname === '/ws/stream') {
      const runId = url.searchParams.get('runId');
      const ticket = url.searchParams.get('ticket');
      const apiKey = url.searchParams.get('apiKey');

      // Check either direct server-to-server apiKey or client short-lived ticket
      const isApiKeyValid = apiKey && apiKey === secretToken;
      const ticketResult = ticket ? verifyStreamTicket(ticket, runId || '', secretToken) : { valid: false };

      if (!runId || (!isApiKeyValid && !ticketResult.valid)) {
        console.warn(`[StreamServer] Upgrade rejected (401): runId=${runId}, apiKeyValid=${isApiKeyValid}, ticketValid=${ticketResult.valid}`);
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      console.log(`[StreamServer] Upgrading client connection for runId: ${runId}`);
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, { runId, userId: ticketResult.userId || 'system' });
      });
    }
  });

  wss.on('connection', async (ws: WebSocket, _request, { runId, userId }: { runId: string; userId: string }) => {
    console.log(`[StreamServer] WebSocket client connected for runId: ${runId} (userId: ${userId})`);
    await BrowserSessionManager.addSubscriber(runId, ws);

    // Handle interactive mouse, keyboard, and browser toolbar commands from client
    ws.on('message', async (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString());
        const session = BrowserSessionManager.getSession(runId);
        if (!session) return;

        if (msg.type === 'INPUT_MOUSE' && msg.event) {
          await session.controller.dispatchMouseEvent(
            msg.event.type,
            msg.event.x,
            msg.event.y,
            msg.event.button,
            msg.event.clickCount || 1,
            msg.event.deltaX || 0,
            msg.event.deltaY || 0
          );
          if (msg.event.type === 'mouseReleased') {
            setTimeout(() => {
              BrowserSessionManager.broadcastState(runId, {
                type: 'STATE',
                url: session.controller.getUrl(),
                title: session.controller.getTitle(),
              });
            }, 300);
          }
        } else if (msg.type === 'INPUT_KEY' && msg.event) {
          await session.controller.dispatchKeyEvent(
            msg.event.type,
            msg.event.key,
            msg.event.code,
            msg.event.text
          );
        } else if (msg.type === 'INPUT_TEXT' && typeof msg.text === 'string') {
          await session.controller.dispatchInsertText(msg.text);
        } else if (msg.type === 'NAV_BACK') {
          console.log(`[StreamServer] Client triggered NAV_BACK for run: ${runId}`);
          await session.controller.goBack();
          BrowserSessionManager.broadcastState(runId, {
            type: 'STATE',
            url: session.controller.getUrl(),
            title: session.controller.getTitle(),
          });
        } else if (msg.type === 'NAV_FORWARD') {
          console.log(`[StreamServer] Client triggered NAV_FORWARD for run: ${runId}`);
          await session.controller.goForward();
          BrowserSessionManager.broadcastState(runId, {
            type: 'STATE',
            url: session.controller.getUrl(),
            title: session.controller.getTitle(),
          });
        } else if (msg.type === 'NAV_RELOAD') {
          console.log(`[StreamServer] Client triggered NAV_RELOAD for run: ${runId}`);
          await session.controller.reload();
          BrowserSessionManager.broadcastState(runId, {
            type: 'STATE',
            url: session.controller.getUrl(),
            title: session.controller.getTitle(),
          });
        } else if (msg.type === 'NAV_GO' && typeof msg.url === 'string') {
          console.log(`[StreamServer] Client navigated address bar to: ${msg.url}`);
          await session.controller.navigate(msg.url);
          BrowserSessionManager.broadcastState(runId, {
            type: 'STATE',
            url: session.controller.getUrl(),
            title: session.controller.getTitle(),
          });
        }
      } catch {
        // Ignore malformed packets
      }
    });

    // Heartbeat keepalive
    let isAlive = true;
    ws.on('pong', () => {
      isAlive = true;
    });

    const pingInterval = setInterval(() => {
      if (!isAlive) {
        clearInterval(pingInterval);
        ws.terminate();
        return;
      }
      isAlive = false;
      try {
        ws.ping();
      } catch {
        clearInterval(pingInterval);
      }
    }, 15000);

    ws.on('close', () => {
      clearInterval(pingInterval);
      BrowserSessionManager.removeSubscriber(runId, ws);
    });

    ws.on('error', () => {
      clearInterval(pingInterval);
      BrowserSessionManager.removeSubscriber(runId, ws);
    });
  });

  return wss;
}

