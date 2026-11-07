import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from 'playwright';

export interface ViewportSize {
  width: number;
  height: number;
}

export interface DiagnosticsState {
  consoleErrors: Array<{ text: string; timestamp: number }>;
  pageErrors: Array<{ message: string; timestamp: number }>;
  failedRequests: Array<{ url: string; method: string; failureText: string; status?: number; timestamp: number }>;
}

export interface BrowserActionSummary {
  action: string;
  selector?: string;
  url?: string;
  value?: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

let sharedBrowser: Browser | null = null;

async function getSharedBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }
  const isHeadless = process.env.CHAOSBULL_HEADLESS === 'true';
  console.log(`[BrowserController] Launching shared Chromium instance (headless: ${isHeadless})...`);
  const t0 = Date.now();
  try {
    sharedBrowser = await chromium.launch({
      headless: isHeadless,
      args: [
        '--no-default-browser-check',
        '--no-first-run',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1280,720',
      ],
    });
    console.log(`[BrowserController] Chromium launched successfully in ${Date.now() - t0}ms`);
    return sharedBrowser;
  } catch (launchErr) {
    console.error(`[BrowserController] Failed to launch Chromium:`, launchErr);
    throw launchErr;
  }
}

export class PlaywrightBrowserController {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private cdpSession: CDPSession | null = null;
  private isScreencasting = false;
  private currentUrl = 'about:blank';
  private currentTitle = 'New Tab';
  private readonly viewport: ViewportSize;
  private readonly diagnostics: DiagnosticsState = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
  };

  constructor(viewport: ViewportSize = { width: 1280, height: 720 }) {
    this.viewport = viewport;
  }

  /**
   * Initializes a fresh, completely isolated browser context and page.
   */
  async initialize(): Promise<void> {
    console.log(`[BrowserController] Initializing isolated browser context (viewport: ${this.viewport.width}x${this.viewport.height})...`);
    const browser = await getSharedBrowser();
    this.context = await browser.newContext({
      viewport: this.viewport,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 ChaosBull/1.0',
      permissions: ['geolocation'],
      geolocation: { latitude: 37.7749, longitude: -122.4194 },
    });

    this.page = await this.context.newPage();
    this.attachDiagnosticListeners(this.page);

    this.page.on('framenavigated', async (frame) => {
      if (this.page && frame === this.page.mainFrame()) {
        this.currentUrl = this.page.url();
        try {
          this.currentTitle = (await this.page.title()) || this.currentUrl;
        } catch {}
      }
    });

    console.log(`[BrowserController] Isolated page created and ready.`);
  }

  private attachDiagnosticListeners(page: Page) {
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        this.diagnostics.consoleErrors.push({
          text: msg.text(),
          timestamp: Date.now(),
        });
      }
    });

    page.on('pageerror', (err) => {
      this.diagnostics.pageErrors.push({
        message: err.message,
        timestamp: Date.now(),
      });
    });

    page.on('requestfailed', (req) => {
      this.diagnostics.failedRequests.push({
        url: req.url(),
        method: req.method(),
        failureText: req.failure()?.errorText || 'Failed',
        timestamp: Date.now(),
      });
    });

    page.on('response', (res) => {
      if (res.status() >= 400) {
        this.diagnostics.failedRequests.push({
          url: res.url(),
          method: res.request().method(),
          failureText: `HTTP ${res.status()} ${res.statusText()}`,
          status: res.status(),
          timestamp: Date.now(),
        });
      }
    });
  }

  /**
   * Starts high-frame-rate CDP screencast, emitting JPEG frames to the callback.
   */
  async startScreencast(onFrame: (frame: { data: string; metadata: any }) => void): Promise<void> {
    if (!this.page || this.isScreencasting) return;

    try {
      console.log(`[BrowserController] Initializing CDP screencast session on page...`);
      this.cdpSession = await this.context!.newCDPSession(this.page);
      this.isScreencasting = true;

      let frameCounter = 0;
      this.cdpSession.on('Page.screencastFrame', async (event: any) => {
        try {
          frameCounter++;
          if (frameCounter === 1) {
            console.log(`[BrowserController] First CDP screencast frame received! Size: ${Math.round(event.data.length / 1024)} KB`);
          }
          onFrame({ data: event.data, metadata: event.metadata });
          if (this.cdpSession) {
            await this.cdpSession.send('Page.screencastFrameAck', { sessionId: event.sessionId });
          }
        } catch {
          // Ignore ack errors on closed sessions
        }
      });

      await this.cdpSession.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 75,
        maxWidth: this.viewport.width,
        maxHeight: this.viewport.height,
        everyNthFrame: 1,
      });
      console.log(`[BrowserController] CDP Page.startScreencast initiated successfully.`);
    } catch (err) {
      console.error('[BrowserController] Failed to start CDP screencast:', err);
    }
  }

  /**
   * Highlights target element with a visible halo indicator so the user can watch the AI interaction.
   */
  private async highlightElement(selector: string, color = '#D82542'): Promise<void> {
    if (!this.page) return;
    try {
      await this.page.evaluate(
        ({ sel, col }) => {
          let el = document.querySelector(sel);
          if (!el) {
            const candidates = Array.from(document.querySelectorAll('button, a, input, [role="button"]'));
            el = candidates.find((c) => (c.textContent || '').toLowerCase().includes(sel.toLowerCase())) || null;
          }
          if (el) {
            const prevOutline = (el as HTMLElement).style.outline;
            const prevBoxShadow = (el as HTMLElement).style.boxShadow;
            (el as HTMLElement).style.outline = `3px solid ${col}`;
            (el as HTMLElement).style.boxShadow = `0 0 18px ${col}`;
            setTimeout(() => {
              try {
                (el as HTMLElement).style.outline = prevOutline;
                (el as HTMLElement).style.boxShadow = prevBoxShadow;
              } catch {}
            }, 2000);
          }
        },
        { sel: selector, col: color }
      );
    } catch {
      // Non-critical visual effect
    }
  }

  async inspectDom(): Promise<Array<{
    tag: string;
    text: string;
    type?: string;
    placeholder?: string;
    selector: string;
    disabled?: boolean;
    ariaDisabled?: boolean;
    contextText?: string;
  }>> {
    this.ensureReady();
    try {
      // Ensure SPA interactive elements have mounted
      await this.page!.waitForSelector('button, a, input, select, textarea, [role="button"]', { timeout: 3500 }).catch(() => {});
      return await this.page!.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('button, a, input, select, textarea, [role="button"]'));
        return elements.slice(0, 50).map((el) => {
          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
          const type = (el as HTMLInputElement).type || undefined;
          const placeholder = (el as HTMLInputElement).placeholder || undefined;
          const name = (el as HTMLInputElement).name || undefined;
          const id = el.id ? `#${el.id}` : '';
          const disabled = (el as HTMLButtonElement).disabled || false;
          const ariaDisabled = el.getAttribute('aria-disabled') === 'true';

          // Look for nearby contextual helper text or descriptions (e.g. "Requires location access for local weather.", "Getting weather...")
          let contextText = '';
          const parent = el.closest('div, form, section, fieldset, label');
          if (parent) {
            const parentText = (parent.textContent || '').trim().replace(/\s+/g, ' ');
            if (/location|weather|required|temperature|permission|gps|loading|error/i.test(parentText)) {
              contextText = parentText.slice(0, 120);
            }
          }

          let selector = id;
          if (!selector) {
            if (name) selector = `${tag}[name="${name}"]`;
            else if (placeholder) selector = `${tag}[placeholder*="${placeholder.slice(0, 20)}"]`;
            else if (text && (tag === 'button' || el.getAttribute('role') === 'button')) selector = `button:has-text("${text}")`;
            else if (text && tag === 'a') selector = `a:has-text("${text}")`;
            else selector = tag;
          }

          return { tag, text, type, placeholder, selector, disabled, ariaDisabled, contextText: contextText || undefined };
        });
      });
    } catch {
      return [];
    }
  }

  /**
   * Discovers and extracts verified, real internal routes on the current website.
   * Filters out external links, anchor jumps, asset files, and duplicates.
   */
  async discoverRoutes(): Promise<Array<{ url: string; path: string; text: string }>> {
    this.ensureReady();
    try {
      // Ensure navigation links have rendered
      await this.page!.waitForSelector('a[href], nav, header, button', { timeout: 3000 }).catch(() => {});
      return await this.page!.evaluate(() => {
        const origin = window.location.origin;
        const links = Array.from(document.querySelectorAll('a[href]'));
        const seen = new Set<string>();
        const results: Array<{ url: string; path: string; text: string }> = [];

        for (const a of links) {
          const href = (a as HTMLAnchorElement).href;
          const text = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);

          if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
            continue;
          }

          try {
            const parsed = new URL(href, origin);
            // Only same-origin internal routes
            if (parsed.origin !== origin) continue;

            const path = parsed.pathname;
            // Exclude empty or hash-only on root
            if (!path || (path === window.location.pathname && parsed.hash)) continue;
            // Exclude static assets
            if (/\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|tar|gz|css|js|map|txt|xml|json)$/i.test(path)) continue;

            const cleanUrl = `${origin}${path}`;
            if (!seen.has(cleanUrl)) {
              seen.add(cleanUrl);
              results.push({ url: cleanUrl, path, text: text || path });
            }
          } catch {}
        }
        return results.slice(0, 15);
      });
    } catch {
      return [];
    }
  }

  async navigate(url: string): Promise<BrowserActionSummary> {
    this.ensureReady();
    console.log(`[BrowserController] Navigating page to: ${url}...`);
    const start = Date.now();
    try {
      await this.page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Allow client-side React / Next.js / Vite SPA hydration to mount interactive elements
      await this.page!.waitForSelector('button, a, input, [role="button"], form', { timeout: 4000 }).catch(() => {});
      this.currentUrl = this.page!.url();
      this.currentTitle = (await this.page!.title().catch(() => '')) || url;
      console.log(`[BrowserController] Navigation complete in ${Date.now() - start}ms. Title: "${this.currentTitle}"`);

      return {
        action: 'navigate',
        url,
        success: true,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[BrowserController] Navigation error for ${url}:`, msg);
      return {
        action: 'navigate',
        url,
        success: false,
        durationMs: Date.now() - start,
        error: msg,
      };
    }
  }

  async click(selector: string): Promise<BrowserActionSummary> {
    this.ensureReady();
    const start = Date.now();
    try {
      let locator = this.page!.locator(selector).first();
      let count = await locator.count().catch(() => 0);

      // If exact selector didn't match, attempt text / button fallback
      if (count === 0) {
        locator = this.page!.locator(`button, a, [role="button"], input[type="submit"]`).filter({ hasText: selector }).first();
        count = await locator.count().catch(() => 0);
      }
      if (count === 0) {
        locator = this.page!.locator(`text="${selector}"`).first();
        count = await locator.count().catch(() => 0);
      }

      if (count > 0) {
        await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
        await this.highlightElement(selector, '#D82542');
        await this.page!.waitForTimeout(300);
        await locator.click({ timeout: 10000 });
      } else {
        await this.highlightElement(selector, '#D82542');
        await this.page!.waitForTimeout(200);
        await this.page!.click(selector, { timeout: 10000 });
      }

      this.currentUrl = this.page!.url();
      this.currentTitle = (await this.page!.title().catch(() => '')) || this.currentUrl;

      return {
        action: 'click',
        selector,
        success: true,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        action: 'click',
        selector,
        success: false,
        durationMs: Date.now() - start,
        error: msg,
      };
    }
  }

  async fill(selector: string, text: string): Promise<BrowserActionSummary> {
    this.ensureReady();
    const start = Date.now();
    try {
      let locator = this.page!.locator(selector).first();
      let count = await locator.count().catch(() => 0);

      if (count === 0) {
        locator = this.page!.locator(`input[name*="${selector}" i], input[id*="${selector}" i], input[placeholder*="${selector}" i]`).first();
        count = await locator.count().catch(() => 0);
      }
      if (count === 0) {
        locator = this.page!.locator('input:not([type="hidden"]), textarea').first();
        count = await locator.count().catch(() => 0);
      }

      if (count > 0) {
        await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
        await this.highlightElement(selector, '#2563EB');
        await locator.fill('', { timeout: 5000 }).catch(() => {});
        await locator.type(text, { delay: 40 });
      } else {
        await this.highlightElement(selector, '#2563EB');
        await this.page!.fill(selector, '', { timeout: 5000 });
        await this.page!.type(selector, text, { delay: 40 });
      }

      return {
        action: 'fill',
        selector,
        value: text,
        success: true,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        action: 'fill',
        selector,
        value: text,
        success: false,
        durationMs: Date.now() - start,
        error: msg,
      };
    }
  }

  async submit(selector?: string): Promise<BrowserActionSummary> {
    this.ensureReady();
    const start = Date.now();
    try {
      if (selector) {
        let locator = this.page!.locator(selector).first();
        let count = await locator.count().catch(() => 0);

        if (count === 0) {
          // Fallback to common submit buttons
          locator = this.page!.locator('button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Send"), button:has-text("Sign"), button:has-text("Register")').first();
          count = await locator.count().catch(() => 0);
        }

        if (count > 0) {
          await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await this.highlightElement(selector, '#059669');
          await locator.click({ timeout: 5000 });
        } else {
          // If no submit button found, press Enter to submit active form
          await this.page!.keyboard.press('Enter');
        }
      } else {
        await this.page!.keyboard.press('Enter');
      }

      await this.page!.waitForTimeout(1000);
      this.currentUrl = this.page!.url();
      this.currentTitle = (await this.page!.title().catch(() => '')) || this.currentUrl;

      return {
        action: 'submit',
        selector,
        success: true,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        action: 'submit',
        selector,
        success: false,
        durationMs: Date.now() - start,
        error: msg,
      };
    }
  }

  /**
   * Scrolls the page viewport smoothly in the specified direction.
   */
  async scroll(direction: 'down' | 'up' | 'bottom' | 'top' = 'down', amount = 600): Promise<BrowserActionSummary> {
    this.ensureReady();
    const start = Date.now();
    try {
      if (direction === 'bottom') {
        await this.page!.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
      } else if (direction === 'top') {
        await this.page!.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      } else if (direction === 'up') {
        await this.page!.evaluate((amt) => window.scrollBy({ top: -amt, behavior: 'smooth' }), amount);
      } else {
        await this.page!.evaluate((amt) => window.scrollBy({ top: amt, behavior: 'smooth' }), amount);
      }
      await this.page!.waitForTimeout(800);

      return {
        action: 'scroll',
        value: `${direction} ${amount}px`,
        success: true,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        action: 'scroll',
        value: direction,
        success: false,
        durationMs: Date.now() - start,
        error: msg,
      };
    }
  }

  /**
   * Scrolls target selector into the center of the viewport.
   */
  async scrollToElement(selector: string): Promise<BrowserActionSummary> {
    this.ensureReady();
    const start = Date.now();
    try {
      let locator = this.page!.locator(selector).first();
      let count = await locator.count().catch(() => 0);
      if (count === 0) {
        locator = this.page!.locator(`text="${selector}"`).first();
        count = await locator.count().catch(() => 0);
      }
      if (count > 0) {
        await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
        await this.highlightElement(selector, '#3B82F6');
      } else {
        await this.page!.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, selector);
      }
      await this.page!.waitForTimeout(600);
      return {
        action: 'scroll_to_element',
        selector,
        success: true,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        action: 'scroll_to_element',
        selector,
        success: false,
        durationMs: Date.now() - start,
        error: msg,
      };
    }
  }

  async injectChaos(type: 'status_code' | 'latency' | 'block' | 'abort' | 'corrupt' | 'network_drop', params: any): Promise<void> {
    this.ensureReady();
    const pattern = params.pattern || '**/api/**';

    if (type === 'status_code') {
      const status = params.status || 503;
      await this.page!.route(pattern, async (route) => {
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ error: `Chaos Injection: HTTP ${status}` }),
        });
      });
    } else if (type === 'latency') {
      const delay = params.delayMs || 2500;
      await this.page!.route(pattern, async (route) => {
        await new Promise((r) => setTimeout(r, delay));
        await route.continue();
      });
    } else if (type === 'block') {
      await this.page!.route(pattern, async (route) => {
        await route.abort('blockedbyclient');
      });
    } else if (type === 'abort' || type === 'network_drop') {
      await this.page!.route(pattern, async (route) => {
        await route.abort('failed');
      });
    } else if (type === 'corrupt') {
      await this.page!.route(pattern, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '<<CORRUPTED_JSON_RESPONSE:ERR_BAD_PAYLOAD_CHAOSBULL>>',
        });
      });
    }
  }

  /**
   * Clears all simulated chaos network rules to restore normal operation.
   */
  async clearChaos(): Promise<void> {
    if (!this.page) return;
    try {
      await this.page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    } catch {}
  }

  async waitForSelector(selector: string, timeoutMs = 5000): Promise<boolean> {
    if (!this.page) return false;
    try {
      await this.page.waitForSelector(selector, { state: 'visible', timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Captures an immediate full-page JPEG frame for instant UI sync.
   */
  async captureImmediateFrame(): Promise<string | null> {
    if (!this.page) return null;
    try {
      const buffer = await this.page.screenshot({ type: 'jpeg', quality: 75 });
      return buffer.toString('base64');
    } catch {
      return null;
    }
  }

  /**
   * Dispatches a mouse event directly into Chromium using Playwright native mouse API.
   */
  async dispatchMouseEvent(
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel',
    x: number,
    y: number,
    button: 'left' | 'middle' | 'right' = 'left',
    clickCount = 1,
    deltaX = 0,
    deltaY = 0
  ): Promise<void> {
    if (!this.page) return;
    try {
      const roundedX = Math.round(x);
      const roundedY = Math.round(y);
      const btn = button === 'middle' ? 'middle' : button === 'right' ? 'right' : 'left';

      if (type === 'mouseMoved') {
        await this.page.mouse.move(roundedX, roundedY);
      } else if (type === 'mousePressed') {
        await this.page.mouse.move(roundedX, roundedY);
        await this.page.mouse.down({ button: btn, clickCount });
      } else if (type === 'mouseReleased') {
        await this.page.mouse.up({ button: btn, clickCount });
      } else if (type === 'mouseWheel') {
        await this.page.mouse.wheel(deltaX, deltaY);
      }
    } catch (err) {
      console.warn('[BrowserController] Mouse dispatch warning:', err);
    }
  }

  /**
   * Dispatches a keyboard event directly into Chromium using Playwright native keyboard API.
   */
  async dispatchKeyEvent(
    type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char',
    key: string,
    code: string,
    text?: string
  ): Promise<void> {
    if (!this.page) return;
    try {
      if (type === 'keyDown') {
        if (key === 'Enter') {
          await this.page.keyboard.press('Enter');
        } else if (key === 'Backspace') {
          await this.page.keyboard.press('Backspace');
        } else if (key === 'Tab') {
          await this.page.keyboard.press('Tab');
        } else if (key === 'Delete') {
          await this.page.keyboard.press('Delete');
        } else if (key === 'Escape') {
          await this.page.keyboard.press('Escape');
        } else if (key.startsWith('Arrow')) {
          await this.page.keyboard.press(key);
        } else if (text || (key.length === 1 && !key.startsWith('F'))) {
          await this.page.keyboard.insertText(text || key);
        } else {
          await this.page.keyboard.down(key);
        }
      } else if (type === 'keyUp') {
        if (!['Enter', 'Backspace', 'Tab', 'Delete', 'Escape'].includes(key) && !key.startsWith('Arrow') && key.length > 1) {
          await this.page.keyboard.up(key);
        }
      }
    } catch (err) {
      console.warn('[BrowserController] Key dispatch warning:', err);
    }
  }

  /**
   * Inserts text directly into the currently focused DOM element.
   */
  async dispatchInsertText(text: string): Promise<void> {
    if (!this.page) return;
    try {
      await this.page.keyboard.insertText(text);
    } catch (err) {
      console.warn('[BrowserController] InsertText warning:', err);
    }
  }

  /**
   * Goes back in the browser history.
   */
  async goBack(): Promise<boolean> {
    if (!this.page) return false;
    try {
      await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
      this.currentUrl = this.page.url();
      this.currentTitle = (await this.page.title().catch(() => '')) || this.currentUrl;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Goes forward in the browser history.
   */
  async goForward(): Promise<boolean> {
    if (!this.page) return false;
    try {
      await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
      this.currentUrl = this.page.url();
      this.currentTitle = (await this.page.title().catch(() => '')) || this.currentUrl;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reloads the current page.
   */
  async reload(): Promise<boolean> {
    if (!this.page) return false;
    try {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      this.currentUrl = this.page.url();
      this.currentTitle = (await this.page.title().catch(() => '')) || this.currentUrl;
      return true;
    } catch {
      return false;
    }
  }

  getDiagnostics(): DiagnosticsState {
    return {
      consoleErrors: [...this.diagnostics.consoleErrors],
      pageErrors: [...this.diagnostics.pageErrors],
      failedRequests: [...this.diagnostics.failedRequests],
    };
  }

  getUrl(): string {
    return this.currentUrl;
  }

  getTitle(): string {
    return this.currentTitle;
  }

  async close(): Promise<void> {
    try {
      if (this.cdpSession) {
        await this.cdpSession.detach().catch(() => {});
        this.cdpSession = null;
      }
      if (this.page) {
        await this.page.close().catch(() => {});
        this.page = null;
      }
      if (this.context) {
        await this.context.close().catch(() => {});
        this.context = null;
      }
    } catch (err) {
      console.error('[BrowserController] Error closing session:', err);
    }
  }

  private ensureReady(): void {
    if (!this.page || !this.context) {
      throw new Error('Browser session not initialized. Call initialize() first.');
    }
  }
}

