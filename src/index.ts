import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { randomUUID } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createChaosBullServer, closeBrowser } from '../../../playwright-network-chaos-mcp/dist/index.js';
import { validateTargetUrl, SSRFSecurityError } from './ssrf.js';
import { BrowserSessionManager, generateStreamTicket } from './session-manager.js';
import { setupStreamWebSocketServer } from './stream-server.js';
import { config } from 'dotenv';

config();

const PORT = parseInt(process.env.MCP_SERVER_PORT || process.env.PORT || '3005', 10);
const MCP_AUTH_TOKEN =
  process.env.CHAOSBULL_MCP_API_KEY ||
  process.env.MCP_AUTH_TOKEN ||
  'chaosbull-dev-secret-token-2026';
const ALLOW_LOCAL = process.env.CHAOSBULL_ALLOW_LOCAL === 'true';

interface ActiveMcpSession {
  id: string;
  server: ReturnType<typeof createChaosBullServer>;
  transport: WebStandardStreamableHTTPServerTransport;
  createdAt: number;
  lastActive: number;
}

const mcpSessions = new Map<string, ActiveMcpSession>();

const app = new Hono();

// Request logging middleware
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  const path = c.req.path;
  if (path !== '/health') {
    console.log(`[MCP Server] ${c.req.method} ${path} -> ${c.res.status} (${duration}ms)`);
  }
});

// Health check endpoint (public, unauthenticated)
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    service: 'chaosbull-remote-mcp-server',
    transport: 'streamable-http',
    streaming: 'websocket-screencast',
    activeMcpSessions: mcpSessions.size,
    timestamp: new Date().toISOString(),
  });
});

// Authentication middleware for MCP and Session endpoints
async function authenticateMcp(c: any, next: () => Promise<void>) {
  const authHeader = c.req.header('authorization');
  const apiKeyHeader = c.req.header('x-api-key');

  let token: string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (apiKeyHeader) {
    token = apiKeyHeader.trim();
  }

  if (!token || token !== MCP_AUTH_TOKEN) {
    return c.json(
      {
        error: 'Unauthorized',
        message: 'Valid Bearer token or x-api-key header required.',
      },
      401
    );
  }

  await next();
}

app.use('/mcp/*', authenticateMcp);
app.use('/mcp', authenticateMcp);
app.use('/session/*', authenticateMcp);
app.use('/session', authenticateMcp);

/* ==========================================================================
   1. LIVE BROWSER SESSION & STREAMING ENDPOINTS
   ========================================================================== */

/**
 * Start or retrieve an isolated browser session for a test run.
 */
app.post('/session/start', async (c) => {
  try {
    const body = await c.req.json();
    const runId = body.runId;
    const userId = body.userId || 'default-user';
    const targetUrl = body.targetUrl || 'about:blank';

    console.log(`[Proxy] /session/start: runId=${runId}, targetUrl=${targetUrl}, userId=${userId}`);

    if (!runId) {
      return c.json({ error: 'Missing required field: runId' }, 400);
    }

    // SSRF Validation
    await validateTargetUrl(targetUrl, ALLOW_LOCAL);

    const session = await BrowserSessionManager.getOrCreateSession(runId, userId, targetUrl);
    const ticket = generateStreamTicket(runId, userId, MCP_AUTH_TOKEN);

    console.log(`[Proxy] /session/start: Session ready (id=${session.id}, status=${session.status})`);

    return c.json({
      success: true,
      runId: session.id,
      status: session.status,
      ticket,
      url: session.controller.getUrl(),
      title: session.controller.getTitle(),
    });
  } catch (err: unknown) {
    if (err instanceof SSRFSecurityError) {
      console.warn(`[Proxy] /session/start SSRF violation: ${err.message}`);
      return c.json({ error: 'SSRF Security Violation', message: err.message }, 400);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Session Start Error]', err);
    return c.json({ error: 'Failed to start browser session', message: msg }, 500);
  }
});

/**
 * Generates an authenticated short-lived stream ticket for the frontend viewer.
 */
app.post('/session/ticket', async (c) => {
  const body = await c.req.json();
  const runId = body.runId;
  const userId = body.userId || 'default-user';

  if (!runId) {
    return c.json({ error: 'Missing runId' }, 400);
  }

  const ticket = generateStreamTicket(runId, userId, MCP_AUTH_TOKEN);
  console.log(`[Proxy] Generated stream ticket for runId=${runId}`);
  return c.json({ success: true, ticket });
});

/**
 * Executes a controlled browser action (navigate, click, fill, submit, chaos).
 */
app.post('/session/action', async (c) => {
  try {
    const body = await c.req.json();
    const { runId, action, params = {} } = body;

    const session = BrowserSessionManager.getSession(runId);
    if (!session || session.status === 'closed') {
      return c.json({ error: 'Session not found or closed' }, 404);
    }

    session.lastActive = Date.now();
    BrowserSessionManager.broadcastState(runId, {
      type: 'ACTION_START',
      action,
      params,
    });

    let result: any = null;

    if (action === 'navigate') {
      await validateTargetUrl(params.url, ALLOW_LOCAL);
      session.status = 'navigating';
      BrowserSessionManager.broadcastState(runId, { type: 'BROWSER_STATUS', status: 'navigating', url: params.url });
      result = await session.controller.navigate(params.url);
      session.status = 'live';
      BrowserSessionManager.broadcastState(runId, {
        type: 'BROWSER_STATUS',
        status: 'live',
        url: session.controller.getUrl(),
        title: session.controller.getTitle(),
      });
    } else if (action === 'click') {
      result = await session.controller.click(params.selector);
    } else if (action === 'fill') {
      result = await session.controller.fill(params.selector, params.text || '');
    } else if (action === 'submit') {
      result = await session.controller.submit(params.selector);
    } else if (action === 'scroll') {
      result = await session.controller.scroll(params.direction || 'down', params.amount || 600);
    } else if (action === 'scroll_to_element') {
      result = await session.controller.scrollToElement(params.selector);
    } else if (action === 'inject_chaos') {
      await session.controller.injectChaos(params.type || 'status_code', params);
      result = { action: 'inject_chaos', success: true };
    } else if (action === 'clear_chaos') {
      await session.controller.clearChaos();
      result = { action: 'clear_chaos', success: true };
    } else if (action === 'wait_for') {
      const found = await session.controller.waitForSelector(params.selector, params.timeoutMs);
      result = { action: 'wait_for', selector: params.selector, success: found };
    } else if (action === 'inspect_dom') {
      const elements = await session.controller.inspectDom();
      result = { action: 'inspect_dom', elements, success: true };
    } else {
      return c.json({ error: `Unknown action: "${action}"` }, 400);
    }

    BrowserSessionManager.broadcastState(runId, {
      type: 'ACTION_COMPLETE',
      action,
      result,
      url: session.controller.getUrl(),
      title: session.controller.getTitle(),
    });

    return c.json({
      success: result.success !== false,
      action,
      result,
      diagnostics: session.controller.getDiagnostics(),
      currentUrl: session.controller.getUrl(),
      currentTitle: session.controller.getTitle(),
    });
  } catch (err: unknown) {
    if (err instanceof SSRFSecurityError) {
      return c.json({ error: 'SSRF Security Violation', message: err.message }, 400);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Session Action Error]', err);
    return c.json({ error: 'Action execution failed', message: msg }, 500);
  }
});

/**
 * Returns current diagnostics (console errors, page errors, failed requests) for a session.
 */
app.get('/session/:runId/diagnostics', async (c) => {
  const runId = c.req.param('runId');
  const session = BrowserSessionManager.getSession(runId);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  return c.json({
    success: true,
    runId,
    diagnostics: session.controller.getDiagnostics(),
    currentUrl: session.controller.getUrl(),
    currentTitle: session.controller.getTitle(),
  });
});

/**
 * Gracefully shuts down a browser session.
 */
app.post('/session/stop', async (c) => {
  const body = await c.req.json();
  const { runId } = body;

  if (runId) {
    await BrowserSessionManager.closeSession(runId);
  }

  return c.json({ success: true, message: 'Session closed' });
});

/* ==========================================================================
   2. MCP STREAMABLE HTTP TRANSPORT
   ========================================================================== */

app.all('/mcp', async (c) => {
  const req = c.req.raw;
  const sessionId = c.req.header('mcp-session-id');

  // Existing MCP session
  if (sessionId) {
    const session = mcpSessions.get(sessionId);
    if (!session) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32001, message: `Session "${sessionId}" not found or expired.` },
          id: null,
        },
        404
      );
    }

    session.lastActive = Date.now();

    if (c.req.method === 'DELETE') {
      await session.transport.close().catch(() => {});
      mcpSessions.delete(sessionId);
      return c.text('Session terminated successfully', 200);
    }

    return await session.transport.handleRequest(req);
  }

  // New MCP session initialization
  if (c.req.method === 'POST') {
    const newSessionId = randomUUID();

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
    });

    const server = createChaosBullServer();
    await server.connect(transport);

    mcpSessions.set(newSessionId, {
      id: newSessionId,
      server,
      transport,
      createdAt: Date.now(),
      lastActive: Date.now(),
    });

    return await transport.handleRequest(req);
  }

  return c.json(
    {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: Initialization must be HTTP POST' },
      id: null,
    },
    400
  );
});

// Periodic idle cleanup
setInterval(async () => {
  await BrowserSessionManager.cleanupIdleSessions();
  const now = Date.now();
  for (const [id, session] of mcpSessions.entries()) {
    if (now - session.lastActive > 15 * 60 * 1000) {
      await session.transport.close().catch(() => {});
      mcpSessions.delete(id);
    }
  }
}, 60000);

// Graceful shutdown
const cleanup = async () => {
  console.log('\n[MCP Server] Gracefully shutting down...');
  for (const [id] of mcpSessions.entries()) {
    mcpSessions.delete(id);
  }
  await closeBrowser().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

console.log(`=======================================================`);
console.log(`  CHAOSBULL LIVE EXECUTION & STREAMING SERVER        `);
console.log(`=======================================================`);
console.log(`  HTTP Endpoint:  http://127.0.0.1:${PORT}`);
console.log(`  Live Stream WS: ws://127.0.0.1:${PORT}/ws/stream`);
console.log(`  MCP Endpoint:   http://127.0.0.1:${PORT}/mcp`);
console.log(`  Health Check:   http://127.0.0.1:${PORT}/health`);
console.log(`  Auth Mode:      Bearer / x-api-key required`);
console.log(`  Allow Local:    ${ALLOW_LOCAL}`);
console.log(`=======================================================\n`);

const serverInstance = serve({
  fetch: app.fetch,
  port: PORT,
});

setupStreamWebSocketServer(serverInstance as any, MCP_AUTH_TOKEN);

export { app, PORT, MCP_AUTH_TOKEN };
