// Bambu Lab print progress on the BUSY Bar, read from Bambu Cloud over HTTP.
// Live progress is only published over MQTT, which the bar can't open, so the printer's state comes from the
// device list (print_status) and progress/time left are estimated from the latest task's start time and the
// slicer's duration estimate.
// Sign-in uses the account email and password; when Bambu asks for an emailed code instead (new device, 2FA),
// the code is typed into the app's settings. The access token is kept in localStorage.
// OK refreshes now (or resends the login code while waiting for one), Back quits.

import { device } from "@shared/device";
import { loadValues, saveValues, type SettingsValues } from "@shared/settings";
import { generateXpm2, textWidth } from "@busy-app/busy-lib";
import manifest from "./appmeta/manifest.json";

const APP = manifest.id;
const TOKEN_KEY = "token";

const ACTIVE_POLL_MS = 60 * 1000;
const IDLE_POLL_MS = 2 * 60 * 1000;
const SETUP_POLL_MS = 15 * 1000;
const RETRY_MS = 30 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const TICK_MS = 60 * 1000;
const ANIM_MS = 500;

const GREEN = "#00FF60FF";
const CYAN = "#00C8FFFF";
const AMBER = "#FFB000FF";
const RED = "#FF2020FF";
const SUBTLE = "#FFFFFF99";

// Literal `font:` properties are how the busy-cli build knows which glyph maps textWidth() needs.
const SMALL = { font: "small" } as const;
const BOLD = { font: "bold" } as const;

type DrawElement = Parameters<typeof device.DisplayDraw>[0]["elements"][number];
type Status = "running" | "pause" | "prepare" | "finish" | "failed" | "idle" | "offline";

const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

interface Printer {
  name: string;
  status: Status;
  task: string;
  /** Task start, ms since the epoch; 0 when unknown. */
  start: number;
  /** Slicer's estimated duration in seconds; 0 when unknown. */
  estimate: number;
}

interface Config {
  email: string;
  password: string;
  code: string;
  api: string;
  printer: string;
  blink: boolean;
  animate: boolean;
}

class AuthError extends Error {}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return isFinite(n) ? n : 0;
};

function readConfig(values: SettingsValues): Config {
  return {
    email: str(values.email),
    password: typeof values.password === "string" ? values.password : "",
    code: str(values.code).replace(/\s/g, ""),
    api: values.region === "china" ? "https://api.bambulab.cn" : "https://api.bambulab.com",
    printer: str(values.printer).toLowerCase(),
    blink: values.blink !== false,
    animate: values.animate !== false,
  };
}

/** The Settings global can come back empty on the device; the settings API is the fallback. */
async function readValues(): Promise<SettingsValues> {
  const values = await loadValues();
  if (values && typeof values.email === "string") return values;
  try {
    const doc = await device.AppsSettingsGet({ app_id: APP });
    return (doc.values ?? {}) as SettingsValues;
  } catch (err) {
    report(err);
    return values ?? {};
  }
}

function loadToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (err) {
    report(err);
  }
}

async function request(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  if (response.status === 401) throw new AuthError("HTTP 401");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await response.text()) as Record<string, unknown>;
  } catch {
    throw new Error(`HTTP ${response.status}, not JSON`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} ${str(body.message) || str(body.error)}`);
  return body;
}

const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function sendCode(cfg: Config): Promise<void> {
  // Success is an empty 200, so only the status is checked.
  const response = await fetch(`${cfg.api}/v1/user-service/user/sendemail/code`, jsonPost({ email: cfg.email, type: "codeLogin" }));
  if (!response.ok) throw new Error(`send code HTTP ${response.status}`);
}

type LoginResult = { token: string } | { needsCode: true } | { refused: string };

/** Logs in with a password or an emailed code. Rejections come back as results; only network/server errors throw. */
async function login(cfg: Config, secret: { password: string } | { code: string }): Promise<LoginResult> {
  const response = await fetch(`${cfg.api}/v1/user-service/user/login`, jsonPost({ account: cfg.email, ...secret }));
  if (response.status >= 500) throw new Error(`login HTTP ${response.status}`);
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(await response.text()) as Record<string, unknown>;
  } catch {
    // An error page instead of JSON reads as a refusal below.
  }
  const token = str(body.accessToken);
  if (token) return { token };
  // verifyCode: new device needs an emailed code. tfa: 2FA account; an emailed code logs it in too.
  const type = str(body.loginType);
  if (type === "verifyCode" || type === "tfa") return { needsCode: true };
  return { refused: str(body.message) || str(body.error) || `HTTP ${response.status}` };
}

/** Maps the device list's print_status (RUNNING, PAUSE, SUCCESS, FAILED, ...) onto what the screen shows. */
function toStatus(online: boolean, raw: string): Status {
  if (!online) return "offline";
  const s = raw.toUpperCase();
  if (s.includes("FAIL") || s.includes("ERROR")) return "failed";
  if (s.includes("PAUSE")) return "pause";
  if (s.includes("PREPARE") || s.includes("SLICING")) return "prepare";
  if (s.includes("RUN") || s.includes("PRINTING") || s.includes("ACTIVE")) return "running";
  if (s.includes("FINISH") || s.includes("SUCCESS")) return "finish";
  return "idle";
}

/** "2026-10-27T15:26:16Z" → ms since the epoch, without relying on the runtime's Date.parse. */
function parseTime(v: unknown): number {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)/.exec(str(v));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}

async function fetchPrinter(cfg: Config, token: string): Promise<Printer | null> {
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const bind = await request(`${cfg.api}/v1/iot-service/api/user/bind`, auth);
  const devices = Array.isArray(bind.devices) ? (bind.devices as Record<string, unknown>[]) : [];
  const dev = cfg.printer ? devices.find((d) => str(d.name).toLowerCase() === cfg.printer) : devices[0];
  if (!dev) return null;
  const printer: Printer = {
    name: str(dev.name),
    status: toStatus(dev.online !== false, str(dev.print_status)),
    task: "",
    start: 0,
    estimate: 0,
  };
  if (printer.status === "offline" || printer.status === "idle") return printer;
  const tasks = await request(`${cfg.api}/v1/user-service/my/tasks?deviceId=${encodeURIComponent(str(dev.dev_id))}&limit=1`, auth);
  const task = Array.isArray(tasks.hits) ? (tasks.hits[0] as Record<string, unknown> | undefined) : undefined;
  if (task) {
    printer.task = str(task.title);
    printer.start = parseTime(task.startTime);
    printer.estimate = Math.max(0, num(task.costTime));
  }
  return printer;
}

/** Estimated percent done; capped at 99 until the printer reports the finish. */
function progressOf(p: Printer): number {
  if (!p.start || !p.estimate) return 0;
  const done = (Date.now() - p.start) / 1000 / p.estimate;
  return Math.max(0, Math.min(99, Math.floor(done * 100)));
}

function secondsLeft(p: Printer): number {
  return p.start && p.estimate ? p.estimate - (Date.now() - p.start) / 1000 : 0;
}

function formatLeft(seconds: number): string {
  const m = Math.max(0, Math.round(seconds / 60));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}`;
}

function text(id: string, value: string, font: "small" | "bold", color: string, x: number, y: number): DrawElement {
  return { id, type: "text", text: value, ...(font === "bold" ? BOLD : SMALL), color, x, y };
}

/** Small text that marquees when it is wider than `width`. */
function line(id: string, value: string, color: string, x: number, y: number, width: number): DrawElement {
  const el = text(id, value, "small", color, x, y);
  if (textWidth(value, "small") > width) {
    Object.assign(el, { width, scroll_rate: 600, scroll_start_delay: 2000, scroll_repeat_delay: 3000 });
  }
  return el;
}

// The printer on the left, 14×16: frame, gantry rail and bed. The head and the part on the bed are separate
// elements, so animating the head or growing the part resends only that one small element.
const PRINTER_XPM = generateXpm2({
  palette: { "#": "#8C8C8C", "=": "#787878", _: "#B4B4B4", ".": "none" },
  grid: [
    "##############",
    "#............#",
    "#============#",
    ...Array<string>(10).fill("#............#"),
    "#____________#",
    "##############",
    ".##........##.",
  ],
});
const HEAD_XPM = generateXpm2({
  palette: { H: "#E6E6E6", N: "#FF7A00", ".": "none" },
  grid: ["HHHHH", "HHHHH", ".HHH.", "..N.."],
});
/** Head x positions along the rail, one per animation step: a sweep back and forth over the part. */
const HEAD_X = [1, 2, 4, 6, 8, 8, 6, 4, 2, 1];
const HEAD_PARK = 1;
/** The part sits on the bed (bottom row 12) and grows up to just under the nozzle tip (row 5). */
const PART_MAX = 6;

/** Empty columns kept at the left and right edges. */
const MARGIN = 2;
const RIGHT = 72 - MARGIN;
/** Text column starts right of the printer. */
const TEXT_X = MARGIN + 16;
const TEXT_W = RIGHT - TEXT_X;
const TIME = "#E6E6E6FF";

function printerIcon(headX: number, part: number, color: string): DrawElement[] {
  const els: DrawElement[] = [
    { id: "printer", type: "xpmbitmap", data: PRINTER_XPM, x: MARGIN, y: 0 },
    { id: "head", type: "xpmbitmap", data: HEAD_XPM, x: MARGIN + headX, y: 2, z_index: 2 },
  ];
  const h = Math.ceil(Math.max(0, Math.min(1, part)) * PART_MAX);
  if (h > 0) {
    els.push({ id: "part", type: "rectangle", x: MARGIN + 4, y: 13 - h, width: 6, height: h, fill: "solid", fill_colors: [color], border_width: 0, z_index: 1 });
  }
  return els;
}

/**
 * Printer, then bold percent and time left side by side, over the print's name. Bold caps are on rows 1–7, the
 * name's small caps on rows 9–13. Time left drops to the small font (caps aligned on row 7) if it doesn't fit.
 */
function progressFrame(p: Printer, color: string, status: string, headX: number): DrawElement[] {
  const progress = progressOf(p);
  const pct = `${progress}%`;
  const x = TEXT_X + textWidth(pct, "bold") + 2;
  const fits = x + textWidth(status, "bold") <= RIGHT;
  return [
    ...printerIcon(headX, progress / 100, color),
    text("pct", pct, "bold", color, TEXT_X, -1),
    fits ? text("line1", status, "bold", TIME, x, -1) : text("line1", status, "small", TIME, x, 1),
    line("line2", p.task || p.name, SUBTLE, TEXT_X, 7, TEXT_W),
  ];
}

/** Printer, then a colored title over a line of detail. */
function messageFrame(title: string, color: string, detail: string, part = 0): DrawElement[] {
  return [
    ...printerIcon(HEAD_PARK, part, color),
    line("line1", title, color, TEXT_X, 0, TEXT_W),
    line("line2", detail, SUBTLE, TEXT_X, 7, TEXT_W),
  ];
}

function main(): void {
  let printer: Printer | null = null;
  let title = "Bambu";
  let message = "Loading...";
  let failures = 0;
  let polling = false;
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let codeSent = false;
  /** Bambu asked for an emailed code on the last password login. */
  let needsCode = false;
  /** A password Bambu rejected; not retried until the setting changes, to avoid locking the account. */
  let rejectedPassword = "";
  /** The last code tried; clearing the field may not be allowed, and a used code can't log in again. */
  let usedCode = "";
  let lastStatus = "";
  let blinkColor: string | null = null;
  let animate = true;
  let animStep = 0;
  let animTimer: ReturnType<typeof setInterval> | null = null;

  let shown = new Map<string, string>();
  let drawing = false;
  let redrawPending = false;

  function frame(): DrawElement[] {
    const p = printer;
    if (!p) return messageFrame(title, CYAN, message);
    switch (p.status) {
      case "running":
        return progressFrame(p, GREEN, p.estimate ? formatLeft(secondsLeft(p)) : "Printing", animTimer ? HEAD_X[animStep] : HEAD_PARK);
      case "pause":
        return progressFrame(p, AMBER, "Paused", HEAD_PARK);
      case "prepare":
        return messageFrame("Preparing", CYAN, p.task || p.name);
      case "failed":
        return messageFrame("Failed", RED, p.task || p.name, 0.5);
      case "finish":
        return messageFrame("Done", GREEN, p.task || "Print finished", 1);
      case "offline":
        return messageFrame("Offline", SUBTLE, p.name);
      default:
        return messageFrame("Idle", SUBTLE, p.name);
    }
  }

  async function draw(): Promise<void> {
    if (drawing) {
      redrawPending = true;
      return;
    }
    drawing = true;
    try {
      const elements = frame();
      const next = new Map<string, string>();
      const changed: DrawElement[] = [];
      for (const el of elements) {
        const json = JSON.stringify(el);
        next.set(el.id, json);
        if (shown.get(el.id) !== json) changed.push(el);
      }
      const removed = [...shown.keys()].filter((id) => !next.has(id));
      const led = blinkColor;
      if (removed.length) await device.DisplayClear({ application_name: APP, element_ids: removed });
      if (changed.length || led) {
        await device.DisplayDraw({
          application_name: APP,
          priority: 50,
          elements: changed,
          ...(led ? { led_notification_color: led } : {}),
        });
        if (led === blinkColor) blinkColor = null;
      }
      shown = next;
    } catch (err) {
      shown = new Map();
      throw err;
    } finally {
      drawing = false;
      if (redrawPending && !stopped) {
        redrawPending = false;
        void draw().catch(report);
      }
    }
  }

  /** Runs the head animation only while printing, and only if the setting allows it. */
  function syncAnimation(): void {
    const run = !stopped && animate && printer?.status === "running";
    if (run && !animTimer) {
      animTimer = setInterval(() => {
        // Skip a step rather than queue one behind a slow draw.
        if (drawing) return;
        animStep = (animStep + 1) % HEAD_X.length;
        void draw().catch(report);
      }, ANIM_MS);
    } else if (!run && animTimer) {
      clearInterval(animTimer);
      animTimer = null;
      animStep = 0;
    }
  }

  function schedule(ms: number): void {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void poll();
    }, ms);
  }

  function setup(t: string, m: string): number {
    printer = null;
    title = t;
    message = m;
    return SETUP_POLL_MS;
  }

  /** Gets a token without one stored: password first, else an emailed code typed into the settings. */
  async function signIn(values: SettingsValues, cfg: Config): Promise<number> {
    if (!cfg.email) return setup("Setup", "Set Bambu email and password in app settings");
    if (cfg.code && cfg.code !== usedCode) {
      usedCode = cfg.code;
      const result = await login(cfg, { code: cfg.code });
      // A used code can't log in again; clear it so the field is ready for the next one.
      await saveValues({ ...values, code: "" }).catch(report);
      codeSent = false;
      if (!("token" in result)) return setup("Bad code", "Press OK for a new code");
      storeToken(result.token);
      needsCode = false;
      return 0;
    }
    if (cfg.password && !needsCode) {
      if (cfg.password === rejectedPassword) return setup("Bad login", "Check email and password in settings");
      const result = await login(cfg, { password: cfg.password });
      if ("token" in result) {
        storeToken(result.token);
        return 0;
      }
      if ("refused" in result) {
        report(new Error(`login refused: ${result.refused}`));
        rejectedPassword = cfg.password;
        return setup("Bad login", result.refused);
      }
      needsCode = true;
    }
    if (!codeSent) {
      await sendCode(cfg);
      codeSent = true;
    }
    return setup("Check email", "Enter the login code in app settings");
  }

  async function poll(): Promise<void> {
    if (polling || stopped) return;
    polling = true;
    let next = IDLE_POLL_MS;
    try {
      const values = await readValues();
      const cfg = readConfig(values);
      animate = cfg.animate;
      let token = loadToken();
      if (!token) {
        next = await signIn(values, cfg);
        token = loadToken();
      }
      if (token) {
        try {
          const p = await fetchPrinter(cfg, token);
          if (!p) {
            next = setup("No printer", cfg.printer ? `"${cfg.printer}" not found` : "No printers on account");
          } else {
            if (cfg.blink && lastStatus && p.status !== lastStatus) {
              if (p.status === "finish") blinkColor = GREEN;
              if (p.status === "failed") blinkColor = RED;
            }
            lastStatus = p.status;
            printer = p;
            const active = p.status === "running" || p.status === "pause" || p.status === "prepare";
            next = active ? ACTIVE_POLL_MS : IDLE_POLL_MS;
          }
        } catch (err) {
          if (!(err instanceof AuthError)) throw err;
          // Token expired or revoked: sign in again on the next poll.
          report(err);
          storeToken("");
          setup("Signed out", "Signing in again...");
          next = 1000;
        }
      }
      failures = 0;
    } catch (err) {
      report(err);
      failures += 1;
      next = Math.min(RETRY_MS * Math.pow(2, failures - 1), MAX_BACKOFF_MS);
      // Keep the last reading on screen; otherwise say why.
      if (!printer) {
        title = "No connection";
        message = err instanceof Error ? err.message : String(err);
      }
    } finally {
      polling = false;
    }
    if (stopped) return;
    syncAnimation();
    void draw().catch(report);
    schedule(next);
  }

  void draw().catch(report);
  void poll();

  // Time left counts down between polls.
  const tick = setInterval(() => {
    if (printer?.status === "running") void draw().catch(report);
  }, TICK_MS);

  const unbind = listen("input", (event) => {
    if (stopped || event.key === "encoder" || event.action !== "short") return;
    if (event.key === "ok") {
      // Waiting on a code: OK asks for a fresh one.
      if (!loadToken()) codeSent = false;
      if (!polling) schedule(0);
      return;
    }
    if (event.key !== "back") return;

    stopped = true;
    clearInterval(tick);
    syncAnimation();
    if (pollTimer) clearTimeout(pollTimer);
    setTimeout(unbind, 0);
  });
}

main();
