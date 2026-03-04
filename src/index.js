import { Telegraf } from "telegraf";
import dotenv from "dotenv";
import { promises as fs } from "fs";
import http from "http";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";

dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_ENABLED = Boolean(OPENAI_API_KEY);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/oauth2callback";
const APP_BASE_URL = process.env.APP_BASE_URL || "";

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/tasks.readonly"
];

const DEFAULT_STATE = {
  users: {}
};

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
let oauthServer = null;

async function ensureDataStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(STATE_FILE);
  } catch {
    await fs.writeFile(STATE_FILE, JSON.stringify(DEFAULT_STATE, null, 2));
  }
}

async function readState() {
  await ensureDataStore();
  const raw = await fs.readFile(STATE_FILE, "utf8");
  return JSON.parse(raw);
}

async function writeState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function getUserState(state, userId) {
  if (!state.users[userId]) {
    state.users[userId] = {
      lastBrief: null,
      tone: "professionale",
      timezone: "Europe/Rome",
      google: {
        tokens: null,
        calendarId: "primary"
      },
      tasks: [],
      taskCounter: 1,
      notes: "",
      eventCategories: {},
      morningDigestEnabled: true,
      morningDigestTime: "08:30",
      lastMorningDigestDate: null,
      oauthState: null,
      oauthStateCreatedAt: null
    };
  }
  if (!state.users[userId].google) {
    state.users[userId].google = {
      tokens: null,
      calendarId: "primary"
    };
  }
  if (!state.users[userId].timezone) {
    state.users[userId].timezone = "Europe/Rome";
  }
  if (!state.users[userId].tone) {
    state.users[userId].tone = "professionale";
  }
  if (!Array.isArray(state.users[userId].tasks)) {
    state.users[userId].tasks = [];
  }
  if (!state.users[userId].taskCounter) {
    state.users[userId].taskCounter = 1;
  }
  if (typeof state.users[userId].notes !== "string") {
    state.users[userId].notes = "";
  }
  if (!state.users[userId].eventCategories || typeof state.users[userId].eventCategories !== "object") {
    state.users[userId].eventCategories = {};
  }
  if (typeof state.users[userId].morningDigestEnabled !== "boolean") {
    state.users[userId].morningDigestEnabled = true;
  }
  if (!state.users[userId].morningDigestTime) {
    state.users[userId].morningDigestTime = "08:30";
  }
  if (state.users[userId].lastMorningDigestDate === undefined) {
    state.users[userId].lastMorningDigestDate = null;
  }
  return state.users[userId];
}

function isGoogleConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI);
}

function createOAuthClient() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

async function startOAuthServer() {
  if (oauthServer) return;

  const redirectUrl = new URL(GOOGLE_REDIRECT_URI);
  const defaultPort = Number(redirectUrl.port || 3000);
  const port = Number(process.env.PORT || defaultPort);

  oauthServer = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || `${redirectUrl.hostname}:${port}`;
      const proto = req.headers["x-forwarded-proto"] || redirectUrl.protocol.replace(":", "");
      const requestUrl = new URL(req.url, `${proto}://${host}`);
      if (requestUrl.pathname === "/") {
        res.writeHead(302, { Location: "/dashboard/overview" });
        res.end();
        return;
      }

      if (requestUrl.pathname === "/dashboard" || requestUrl.pathname.startsWith("/dashboard/")) {
        const html = await fs.readFile(path.join(PUBLIC_DIR, "dashboard.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (requestUrl.pathname === "/api/overview") {
        const state = await readState();
        const picked = pickUserFromRequest(state, requestUrl.searchParams);
        if (!picked) {
          jsonResponse(res, 404, { error: "Nessun utente disponibile" });
          return;
        }

        const dateQuery = requestUrl.searchParams.get("date") || "oggi";
        const date = parseDateToken(dateQuery) || new Date();
        const range = getDayRange(date);

        let events = [];
        try {
          events = await getCalendarEvents(picked.user, range);
        } catch {
          events = [];
        }

        const eventsWithCategory = events.map((event) => ({
          ...event,
          category: picked.user.eventCategories[event.eventKey] || ""
        }));

        const tasksOpen = picked.user.tasks.filter((task) => !task.done);
        const today = formatDateISO(date);
        const tasksToday = tasksOpen.filter((task) => task.dueDate === today);

        jsonResponse(res, 200, {
          userId: picked.userId,
          date: formatDateISO(date),
          events: eventsWithCategory,
          tasksOpen,
          tasksToday,
          notes: picked.user.notes || ""
        });
        return;
      }

      if (requestUrl.pathname === "/api/event/category" && req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bodyRaw = Buffer.concat(chunks).toString("utf8");
        const body = bodyRaw ? JSON.parse(bodyRaw) : {};

        const eventKey = String(body.eventKey || "").trim();
        const category = String(body.category || "").trim();
        if (!eventKey) {
          jsonResponse(res, 400, { error: "Event key mancante" });
          return;
        }

        const state = await readState();
        const picked = pickUserFromRequest(state, requestUrl.searchParams);
        if (!picked) {
          jsonResponse(res, 404, { error: "Nessun utente disponibile" });
          return;
        }

        if (category) {
          picked.user.eventCategories[eventKey] = category;
        } else {
          delete picked.user.eventCategories[eventKey];
        }
        await writeState(state);
        jsonResponse(res, 200, { ok: true });
        return;
      }

      if (requestUrl.pathname === "/api/notes/save" && req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bodyRaw = Buffer.concat(chunks).toString("utf8");
        const body = bodyRaw ? JSON.parse(bodyRaw) : {};
        const notes = String(body.notes || "");

        const state = await readState();
        const picked = pickUserFromRequest(state, requestUrl.searchParams);
        if (!picked) {
          jsonResponse(res, 404, { error: "Nessun utente disponibile" });
          return;
        }

        picked.user.notes = notes;
        await writeState(state);
        jsonResponse(res, 200, { ok: true });
        return;
      }

      if (requestUrl.pathname === "/api/task/done" && req.method === "POST") {
        const state = await readState();
        const picked = pickUserFromRequest(state, requestUrl.searchParams);
        if (!picked) {
          jsonResponse(res, 404, { error: "Nessun utente disponibile" });
          return;
        }

        const id = Number(requestUrl.searchParams.get("id"));
        if (!id) {
          jsonResponse(res, 400, { error: "ID task non valido" });
          return;
        }

        const task = picked.user.tasks.find((item) => item.id === id);
        if (!task) {
          jsonResponse(res, 404, { error: "Task non trovata" });
          return;
        }

        task.done = true;
        await writeState(state);
        jsonResponse(res, 200, { ok: true });
        return;
      }

      if (requestUrl.pathname === "/api/task/delete" && req.method === "POST") {
        const state = await readState();
        const picked = pickUserFromRequest(state, requestUrl.searchParams);
        if (!picked) {
          jsonResponse(res, 404, { error: "Nessun utente disponibile" });
          return;
        }

        const id = Number(requestUrl.searchParams.get("id"));
        if (!id) {
          jsonResponse(res, 400, { error: "ID task non valido" });
          return;
        }

        const before = picked.user.tasks.length;
        picked.user.tasks = picked.user.tasks.filter((item) => item.id !== id);
        if (picked.user.tasks.length === before) {
          jsonResponse(res, 404, { error: "Task non trovata" });
          return;
        }

        await writeState(state);
        jsonResponse(res, 200, { ok: true });
        return;
      }

      if (requestUrl.pathname === "/api/task/add" && req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bodyRaw = Buffer.concat(chunks).toString("utf8");
        const body = bodyRaw ? JSON.parse(bodyRaw) : {};

        const title = String(body.title || "").trim();
        if (!title) {
          jsonResponse(res, 400, { error: "Titolo task obbligatorio" });
          return;
        }

        const state = await readState();
        const picked = pickUserFromRequest(state, requestUrl.searchParams);
        if (!picked) {
          jsonResponse(res, 404, { error: "Nessun utente disponibile" });
          return;
        }

        const priority = parsePriority(String(body.priority || "media"));
        const dueDate = body.dueDate ? parseDateToken(String(body.dueDate)) : null;
        const tags = Array.isArray(body.tags)
          ? body.tags.map((tag) => String(tag).toLowerCase()).filter(Boolean)
          : [];

        const task = {
          id: picked.user.taskCounter,
          title,
          priority,
          dueDate: dueDate ? formatDateISO(dueDate) : null,
          tags,
          done: false,
          createdAt: new Date().toISOString()
        };
        picked.user.tasks.push(task);
        picked.user.taskCounter += 1;
        await writeState(state);
        jsonResponse(res, 200, { ok: true, task });
        return;
      }

      if (requestUrl.pathname !== "/oauth2callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const code = requestUrl.searchParams.get("code");
      const stateToken = requestUrl.searchParams.get("state");

      if (!code || !stateToken) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing code or state");
        return;
      }

      const state = await readState();
      if (!state.users) state.users = {};
      const userId = Object.keys(state.users).find(
        (id) => state.users[id]?.oauthState === stateToken
      );

      if (!userId) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Stato non valido. Riprova dal comando /gcal.");
        return;
      }

      const oauth2Client = createOAuthClient();
      const { tokens } = await oauth2Client.getToken(code);

      const user = getUserState(state, String(userId));
      user.google.tokens = tokens;
      user.oauthState = null;
      user.oauthStateCreatedAt = null;
      await writeState(state);

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h2>Calendario collegato.</h2><p>Ora puoi tornare su Telegram.</p>"
      );
    } catch (err) {
      console.error("OAuth error:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(
        "Errore durante l'autenticazione. Controlla il terminale per dettagli."
      );
    }
  });

  await new Promise((resolve, reject) => {
    oauthServer.once("error", reject);
    oauthServer.listen(port, resolve);
  });
}

function buildAuthUrl(stateToken) {
  const oauth2Client = createOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: GOOGLE_SCOPES,
    prompt: "consent",
    state: stateToken
  });
}

function getDashboardUrl() {
  if (APP_BASE_URL) {
    return `${APP_BASE_URL.replace(/\/$/, "")}/dashboard/overview`;
  }
  const redirectUrl = new URL(GOOGLE_REDIRECT_URI);
  return `${redirectUrl.origin}/dashboard/overview`;
}

function pickUserFromRequest(state, searchParams) {
  if (!state.users) return null;
  const requested = searchParams.get("uid");
  if (requested && state.users[requested]) {
    return { userId: requested, user: getUserState(state, requested) };
  }
  const firstUserId = Object.keys(state.users)[0];
  if (!firstUserId) return null;
  return { userId: firstUserId, user: getUserState(state, firstUserId) };
}

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function buildEventKey({ calendarId, eventId, startDateTime, startDate, summary }) {
  return [calendarId || "", eventId || "", startDateTime || startDate || "", summary || ""].join("|");
}

function getDayRange(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function getFutureRange(days) {
  const start = new Date();
  const end = new Date();
  end.setDate(end.getDate() + days);
  return { start, end };
}

async function getCalendarEvents(user, { start, end }) {
  if (!user.google?.tokens) return [];

  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(user.google.tokens);

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  const calendars = await resolveSelectedCalendars(user);
  const allEvents = [];

  for (const cal of calendars) {
    const response = await calendar.events.list({
      calendarId: cal.id,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50
    });

    const events = response.data.items || [];
    for (const event of events) {
      const summary = event.summary || "Senza titolo";
      const startDateTime = event.start?.dateTime || null;
      const startDate = event.start?.date || null;
      allEvents.push({
        eventId: event.id || "",
        summary,
        startDateTime,
        startDate,
        calendarId: cal.id,
        calendarSummary: cal.summary,
        eventKey: buildEventKey({
          calendarId: cal.id,
          eventId: event.id || "",
          startDateTime,
          startDate,
          summary
        })
      });
    }
  }

  return allEvents;
}

async function listCalendars(user) {
  if (!user.google?.tokens) return [];

  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(user.google.tokens);

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  const response = await calendar.calendarList.list({
    maxResults: 50
  });
  const items = response.data.items || [];

  return items.map((item) => ({
    id: item.id,
    summary: item.summary || "Senza titolo",
    primary: Boolean(item.primary)
  }));
}

async function resolveSelectedCalendars(user) {
  const selected = user.google?.calendarId || "primary";
  const calendars = await listCalendars(user);

  if (selected === "all") return calendars;

  const found = calendars.find((cal) => cal.id === selected);
  if (found) return [found];

  if (selected === "primary") {
    const primary = calendars.find((cal) => cal.primary);
    if (primary) return [primary];
  }

  return [{ id: selected, summary: selected, primary: false }];
}

function formatEventLines(events, { showCalendar = false } = {}) {
  if (!events.length) return "Nessun evento";
  return events
    .map((event) => {
      const calendarLabel = showCalendar && event.calendarSummary
        ? ` (${event.calendarSummary})`
        : "";
      if (event.startDate) {
        return `- Tutto il giorno: ${event.summary}${calendarLabel}`;
      }
      if (!event.startDateTime) return `- ${event.summary}${calendarLabel}`;
      const time = new Date(event.startDateTime).toLocaleTimeString("it-IT", {
        hour: "2-digit",
        minute: "2-digit"
      });
      return `- ${time} ${event.summary}${calendarLabel}`;
    })
    .join("\n");
}

function parsePriority(text) {
  const value = text.toLowerCase();
  if (value.includes("alta") || value.includes("high")) return "alta";
  if (value.includes("bassa") || value.includes("low")) return "bassa";
  return "media";
}

function stripPriorityTokens(text) {
  return text
    .replace(/\b(alta|media|bassa|high|low)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function formatTasks(tasks) {
  if (!tasks.length) return "Nessuna task.";
  return tasks
    .map((task) => {
      const status = task.done ? "✓" : "•";
      const due = task.dueDate ? ` | scadenza: ${task.dueDate}` : "";
      const tags = task.tags.length ? ` | #${task.tags.join(" #")}` : "";
      return `${status} [${task.id}] ${task.title} (${task.priority})${due}${tags}`;
    })
    .join("\n");
}

function parseDateToken(token) {
  if (!token) return null;
  const lower = token.toLowerCase();
  if (lower === "oggi") return new Date();
  if (lower === "domani") {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (lower === "ieri") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d;
  }
  const slashMatch = token.match(/^\d{2}\/\d{2}\/\d{4}$/);
  if (slashMatch) {
    const [day, month, year] = token.split("/").map(Number);
    const d = new Date(year, month - 1, day);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const date = new Date(token);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function extractDateFromText(text) {
  const lower = text.toLowerCase();
  if (lower.includes("oggi")) return { date: parseDateToken("oggi"), label: "oggi" };
  if (lower.includes("domani")) return { date: parseDateToken("domani"), label: "domani" };
  if (lower.includes("ieri")) return { date: parseDateToken("ieri"), label: "ieri" };

  const isoMatch = text.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (isoMatch) {
    const date = parseDateToken(isoMatch[0]);
    if (date) return { date, label: isoMatch[0] };
  }

  const slashMatch = text.match(/\b\d{2}\/\d{2}\/\d{4}\b/);
  if (slashMatch) {
    const date = parseDateToken(slashMatch[0]);
    if (date) return { date, label: slashMatch[0] };
  }

  return null;
}

function formatDateISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getTimePartsInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat("it-IT", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }

  return {
    dateKey: `${map.year}-${map.month}-${map.day}`,
    timeKey: `${map.hour}:${map.minute}`
  };
}

function isValidHHMM(value) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function getTopIlPostArticle() {
  const feedUrl = "https://www.ilpost.it/feed/";
  try {
    const response = await fetch(feedUrl, {
      headers: {
        "User-Agent": "RegiaOSBot/1.0"
      }
    });

    if (response.ok) {
      const xml = await response.text();
      const itemMatch = xml.match(/<item>[\s\S]*?<\/item>/i);
      if (itemMatch) {
        const titleMatch = itemMatch[0].match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i);
        const linkMatch = itemMatch[0].match(/<link>([\s\S]*?)<\/link>/i);
        const rawTitle = (titleMatch?.[1] || titleMatch?.[2] || "Articolo del giorno").trim();
        const rawLink = (linkMatch?.[1] || "").trim();
        if (rawLink) {
          return { title: rawTitle, link: rawLink };
        }
      }
    }
  } catch {
  }

  const homeResponse = await fetch("https://www.ilpost.it/", {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });
  if (!homeResponse.ok) {
    throw new Error("Homepage Il Post non disponibile");
  }

  const html = await homeResponse.text();
  const nextDataMatch = html.match(/<script id=\"__NEXT_DATA__\" type=\"application\/json\">([\s\S]*?)<\/script>/i);
  if (!nextDataMatch) {
    throw new Error("Dati homepage non disponibili");
  }

  const nextData = JSON.parse(nextDataMatch[1]);
  const list = nextData?.props?.pageProps?.data?.data?.rullo?.data?.list || [];
  const firstContent = list
    .map((item) => item?.content)
    .find((content) => content?.title && content?.link);

  if (!firstContent) {
    throw new Error("Nessun articolo trovato in homepage");
  }

  return {
    title: firstContent.title,
    link: firstContent.link
  };
}

async function listUnreadEmails(user, maxResults = 5) {
  if (!user.google?.tokens) {
    return { connected: false, count: 0, items: [] };
  }

  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(user.google.tokens);
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const list = await gmail.users.messages.list({
    userId: "me",
    q: "in:inbox is:unread",
    maxResults
  });

  const messages = list.data.messages || [];
  const count = Number(list.data.resultSizeEstimate || 0);
  if (!messages.length) {
    return { connected: true, count, items: [] };
  }

  const details = await Promise.all(
    messages.map((msg) =>
      gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "metadata",
        metadataHeaders: ["From", "Subject"]
      })
    )
  );

  const items = details.map((detail) => {
    const headers = detail.data.payload?.headers || [];
    const from = headers.find((h) => h.name === "From")?.value || "Sconosciuto";
    const subject = headers.find((h) => h.name === "Subject")?.value || "(Senza oggetto)";
    return { from, subject };
  });

  return { connected: true, count, items };
}

async function listGoogleOpenTasks(user, maxResults = null) {
  if (!user.google?.tokens) {
    return { connected: false, count: 0, items: [] };
  }

  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(user.google.tokens);
  const tasksApi = google.tasks({ version: "v1", auth: oauth2Client });

  const tasklistsResp = await tasksApi.tasklists.list({ maxResults: 10 });
  const lists = tasklistsResp.data.items || [];
  if (!lists.length) {
    return { connected: true, count: 0, items: [] };
  }

  const allItems = [];

  for (const list of lists) {
    const listId = list.id;
    if (!listId) continue;
    const tasksResp = await tasksApi.tasks.list({
      tasklist: listId,
      showCompleted: false,
      showHidden: false,
      maxResults: maxResults && Number.isFinite(maxResults) ? maxResults : 100
    });
    const items = tasksResp.data.items || [];
    for (const task of items) {
      if (!task.title) continue;
      allItems.push({
        title: task.title,
        due: task.due || null,
        listTitle: list.title || "Tasks"
      });
    }
  }

  const sorted = allItems.sort((a, b) => {
    if (a.due && b.due) return new Date(a.due) - new Date(b.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return 0;
  });

  return {
    connected: true,
    count: sorted.length,
    items: maxResults && Number.isFinite(maxResults) ? sorted.slice(0, maxResults) : sorted
  };
}

async function sendTelegramHtmlInChunks(chatId, text, chunkSize = 3500) {
  if (text.length <= chunkSize) {
    await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" });
    return;
  }

  const lines = text.split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > chunkSize) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await bot.telegram.sendMessage(chatId, chunk, { parse_mode: "HTML" });
  }
}

async function sendMorningDigestForUser(userId, user, options = {}) {
  const targetDate = options.targetDate || new Date();
  const header = options.header || "Buongiorno! Ecco il punto della mattina:";
  const dateLabel = formatDateISO(targetDate);
  const range = getDayRange(targetDate);
  let events = [];
  try {
    events = await getCalendarEvents(user, range);
  } catch {
    events = [];
  }

  let googleTasksInfo;
  try {
    googleTasksInfo = await listGoogleOpenTasks(user, null);
  } catch {
    googleTasksInfo = { connected: false, count: 0, items: [] };
  }

  let ilPost;
  try {
    ilPost = await getTopIlPostArticle();
  } catch {
    ilPost = null;
  }

  let mailInfo;
  try {
    mailInfo = await listUnreadEmails(user, 4);
  } catch {
    mailInfo = { connected: false, count: 0, items: [] };
  }

  const mailLines = !mailInfo.connected
    ? "- Gmail non collegato (usa /gcal per autorizzare anche Gmail)"
    : (mailInfo.count === 0
      ? "- Nessuna mail non letta"
      : mailInfo.items.map((m) => `• ${escapeHtml(m.subject)}`).join("\n\n"));

  const googleTaskLines = !googleTasksInfo.connected
    ? "- Google Tasks non collegato (rifai /gcal per autorizzare anche Tasks)"
    : (() => {
      const dueTodayTasks = googleTasksInfo.items.filter((t) => {
        if (!t.due) return false;
        const dueDate = new Date(t.due);
        if (Number.isNaN(dueDate.getTime())) return false;
        const dueKey = getTimePartsInTimezone(dueDate, user.timezone || "Europe/Rome").dateKey;
        return dueKey === dateLabel;
      });

      if (dueTodayTasks.length === 0) {
        return "- Nessuna task Google con scadenza nel giorno";
      }

      return dueTodayTasks.map((t) => `- ${escapeHtml(t.title)}`).join("\n");
    })();

  const dueTodayCount = googleTasksInfo.connected
    ? googleTasksInfo.items.filter((t) => {
      if (!t.due) return false;
      const dueDate = new Date(t.due);
      if (Number.isNaN(dueDate.getTime())) return false;
      const dueKey = getTimePartsInTimezone(dueDate, user.timezone || "Europe/Rome").dateKey;
      return dueKey === dateLabel;
    }).length
    : 0;

  const eventLines = events.length
    ? events.slice(0, 6).map((e) => {
      if (e.startDate) return `- Tutto il giorno: ${escapeHtml(e.summary)}`;
      const time = e.startDateTime
        ? new Date(e.startDateTime).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })
        : "--:--";
      return `- ${escapeHtml(time)} ${escapeHtml(e.summary)}`;
    }).join("\n")
    : "- Nessun appuntamento";

  const text = [
    `<b>${escapeHtml(header)}</b>`,
    `<b>Data:</b> ${escapeHtml(dateLabel)}`,
    "",
    "<b>INBOX</b>",
    `<b>Mail da leggere:</b> ${mailInfo.count || 0}`,
    mailLines,
    "",
    "<b>TASK</b>",
    `<b>Google Tasks con scadenza nel giorno:</b> ${dueTodayCount}`,
    googleTaskLines,
    "",
    "<b>AGENDA</b>",
    `<b>Appuntamenti:</b> ${events.length}`,
    eventLines,
    "",
    "<b>IL POST</b>",
    ilPost
      ? `• <a href=\"${escapeHtml(ilPost.link)}\">${escapeHtml(ilPost.title)}</a>`
      : "- Articolo non disponibile al momento"
  ].join("\n");

  await sendTelegramHtmlInChunks(userId, text);
}

function startMorningDigestScheduler() {
  setInterval(async () => {
    let state;
    try {
      state = await readState();
    } catch {
      return;
    }

    const users = state.users || {};
    let changed = false;

    for (const userId of Object.keys(users)) {
      const user = getUserState(state, userId);
      if (!user.morningDigestEnabled) continue;

      const { dateKey, timeKey } = getTimePartsInTimezone(new Date(), user.timezone || "Europe/Rome");
      if (timeKey !== user.morningDigestTime) continue;
      if (user.lastMorningDigestDate === dateKey) continue;

      try {
        await sendMorningDigestForUser(userId, user);
        user.lastMorningDigestDate = dateKey;
        changed = true;
      } catch {
      }
    }

    if (changed) {
      await writeState(state);
    }
  }, 60000);
}

function extractTags(text) {
  const matches = text.match(/#\w+/g) || [];
  return matches.map((tag) => tag.slice(1).toLowerCase());
}

function removeTags(text) {
  return text.replace(/#\w+/g, "").replace(/\s{2,}/g, " ").trim();
}

async function callOpenAI({ system, user }) {
  if (!OPENAI_ENABLED) {
    throw new Error("OpenAI disabled");
  }

  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.7,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

function buildSystemPrompt(mode, tone) {
  const base = "Sei un assistente personale CEO+Creativo. Risposte concise, operative, senza fronzoli.";
  const toneLine = `Tono: ${tone}.`;

  const modes = {
    brief: "Genera priorita, rischi e opportunita. Non inventare eventi o orari; usa solo quelli forniti.",
    meet: "Genera una agenda per meeting, una lista note e un recap con next steps.",
    idea: "Genera 5 idee rapide e diverse.",
    post: "Genera una bozza e 2 varianti di tono.",
    followup: "Scrivi un follow-up breve e cortese, orientato a un next step chiaro."
  };

  return `${base} ${toneLine} ${modes[mode] || ""}`.trim();
}

function wrapReply(text) {
  return text || "Non ho prodotto nulla. Riprova con piu contesto.";
}

async function ensureOpenAIForCommand(ctx) {
  if (OPENAI_ENABLED) return true;
  await ctx.reply("OpenAI e disattivato. Per ora sono attivi calendario, task e morning digest.");
  return false;
}

bot.start(async (ctx) => {
  await ensureDataStore();
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  await writeState(state);

  const intro = [
    "Ciao! Sono Regia OS, il tuo assistente personale.",
    OPENAI_ENABLED ? "Modalita AI: attiva" : "Modalita AI: disattiva (solo automazioni)",
    "Comandi:",
    "/brief - daily brief",
    "/meet <contesto> - meeting kit",
    "/idea <tema> - 5 idee",
    "/post <tema> - bozza + varianti",
    "/followup <contesto> - follow-up breve",
    "/tone <stile> - imposta tono (es. professionale, diretto, creativo)",
    "/task_add <testo> - nuova task",
    "/task_list - elenco task aperte",
    "/task_done <id> - completa task",
    "/task_today - focus oggi",
    "/task_next - prossime task",
    "/dashboard - apri pannello web",
    "/gcal - collega Google Calendar + Gmail + Tasks",
    "/gcal_status - stato collegamento",
    "/gcal_disconnect - scollega Google Calendar",
    "/morning_on - attiva messaggio mattina",
    "/morning_off - disattiva messaggio mattina",
    "/morning_time HH:MM - orario messaggio",
    "/morning_now - invia test ora",
    "/morning_tomorrow - simula messaggio domani",
    "/gtasks_now - task aperte Google Tasks",
    "/gcal_events - eventi di oggi",
    "/gcal_events <oggi|domani|ieri|YYYY-MM-DD|DD/MM/YYYY>",
    "/gcal_events7 - eventi prossimi 7 giorni",
    "/gcal_calendars - lista calendari",
    "/gcal_use <id> - seleziona calendario",
    "/gcal_use all - unisci calendari",
    "",
    `Tono corrente: ${user.tone}`
  ].join("\n");

  await ctx.reply(intro);
});

bot.command("tone", async (ctx) => {
  await ensureDataStore();
  const tone = ctx.message.text.replace("/tone", "").trim();
  if (!tone) {
    await ctx.reply("Usa /tone <stile>. Esempio: /tone diretto");
    return;
  }
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  user.tone = tone;
  await writeState(state);
  await ctx.reply(`Ok. Tono impostato su: ${tone}`);
});

bot.command("brief", async (ctx) => {
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  let events = [];
  try {
    const range = getDayRange(new Date());
    events = await getCalendarEvents(user, range);
  } catch {
    events = [];
  }
  const showCalendar = user.google?.calendarId === "all";
  const eventLines = formatEventLines(events, { showCalendar });
  if (!OPENAI_ENABLED) {
    const fallback = [
      "Daily Brief - Oggi",
      "",
      "Blocchi Agenda:",
      eventLines,
      "",
      "Nota: OpenAI disattivato, quindi priorita/rischi/opportunita non sono generate automaticamente."
    ].join("\n");
    user.lastBrief = new Date().toISOString();
    await writeState(state);
    await ctx.reply(fallback);
    return;
  }

  const system = buildSystemPrompt("brief", user.tone);
  const userMsg = [
    "Genera priorita, rischi e opportunita del giorno. Usa punti elenco.",
    "Non inventare eventi o orari.",
    "",
    "Eventi di oggi:",
    eventLines
  ].join("\n");
  const aiPart = await callOpenAI({ system, user: userMsg });
  const agendaSection = `Blocchi Agenda:\n${eventLines}`;
  const reply = `Daily Brief - Oggi\n\n${agendaSection}\n\n${aiPart}`;
  user.lastBrief = new Date().toISOString();
  await writeState(state);
  await ctx.reply(wrapReply(reply));
});

bot.command("gcal_events", async (ctx) => {
  const raw = ctx.message.text.replace("/gcal_events", "").trim();
  const picked = extractDateFromText(raw);
  const targetDate = picked?.date || new Date();
  const label = picked?.label || "oggi";

  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  let events = [];
  try {
    const range = getDayRange(targetDate);
    events = await getCalendarEvents(user, range);
  } catch {
    events = [];
  }
  const showCalendar = user.google?.calendarId === "all";
  const lines = formatEventLines(events, { showCalendar });
  await ctx.reply(`Eventi ${label}:\n${lines}`);
});

bot.command("gcal_events7", async (ctx) => {
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  let events = [];
  try {
    const range = getFutureRange(7);
    events = await getCalendarEvents(user, range);
  } catch {
    events = [];
  }
  const showCalendar = user.google?.calendarId === "all";
  const lines = formatEventLines(events, { showCalendar });
  await ctx.reply(`Eventi prossimi 7 giorni:\n${lines}`);
});

bot.command("gcal_calendars", async (ctx) => {
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  let calendars = [];
  try {
    calendars = await listCalendars(user);
  } catch {
    calendars = [];
  }

  if (!calendars.length) {
    await ctx.reply("Nessun calendario trovato.");
    return;
  }

  const lines = calendars
    .map((cal) => {
      const primary = cal.primary ? " (primary)" : "";
      return `- ${cal.summary}${primary}\n  id: ${cal.id}`;
    })
    .join("\n");

  await ctx.reply(
    [
      "Calendari disponibili:",
      lines,
      "",
      "Usa /gcal_use <id> per selezionare.",
      "Oppure /gcal_use all per unirli tutti."
    ].join("\n")
  );
});

bot.command("gcal_use", async (ctx) => {
  const calendarId = ctx.message.text.replace("/gcal_use", "").trim();
  if (!calendarId) {
    await ctx.reply("Usa /gcal_use <id>. Puoi ottenere gli id con /gcal_calendars.");
    return;
  }
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  if (calendarId === "all") {
    user.google.calendarId = "all";
    await writeState(state);
    await ctx.reply("Calendari uniti: usero tutti i calendari.");
    return;
  }
  user.google.calendarId = calendarId;
  await writeState(state);
  await ctx.reply(`Calendario selezionato: ${calendarId}`);
});

bot.command("gcal", async (ctx) => {
  if (!isGoogleConfigured()) {
    await ctx.reply(
      "Google Calendar non configurato. Aggiungi GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REDIRECT_URI nel file .env e riavvia il bot."
    );
    return;
  }

  try {
    await startOAuthServer();
  } catch {
    await ctx.reply(
      "Non riesco ad avviare il server locale su http://localhost:3000. Chiudi altri programmi che usano la porta 3000 e riprova."
    );
    return;
  }

  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  const stateToken = crypto.randomBytes(16).toString("hex");
  user.oauthState = stateToken;
  user.oauthStateCreatedAt = Date.now();
  await writeState(state);

  const url = buildAuthUrl(stateToken);
  await ctx.reply(
    [
      "Apri questo link nel browser e autorizza l'accesso (Calendar + Gmail + Tasks):",
      url,
      "",
      "Quando vedi la pagina di conferma, torna su Telegram."
    ].join("\n")
  );
});

bot.command("gcal_status", async (ctx) => {
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  if (user.google?.tokens) {
    await ctx.reply("Google Calendar collegato.");
  } else {
    await ctx.reply("Google Calendar non collegato. Usa /gcal.");
  }
});

bot.command("gcal_disconnect", async (ctx) => {
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  user.google.tokens = null;
  await writeState(state);
  await ctx.reply("Google Calendar scollegato.");
});

bot.command("meet", async (ctx) => {
  if (!(await ensureOpenAIForCommand(ctx))) return;
  const text = ctx.message.text.replace("/meet", "").trim();
  if (!text) {
    await ctx.reply("Aggiungi un contesto. Esempio: /meet allineamento Q2 con team marketing");
    return;
  }
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  const system = buildSystemPrompt("meet", user.tone);
  const reply = await callOpenAI({ system, user: text });
  await ctx.reply(wrapReply(reply));
});

bot.command("idea", async (ctx) => {
  if (!(await ensureOpenAIForCommand(ctx))) return;
  const text = ctx.message.text.replace("/idea", "").trim();
  if (!text) {
    await ctx.reply("Aggiungi un tema. Esempio: /idea campagna lancio app fintech");
    return;
  }
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  const system = buildSystemPrompt("idea", user.tone);
  const reply = await callOpenAI({ system, user: text });
  await ctx.reply(wrapReply(reply));
});

bot.command("post", async (ctx) => {
  if (!(await ensureOpenAIForCommand(ctx))) return;
  const text = ctx.message.text.replace("/post", "").trim();
  if (!text) {
    await ctx.reply("Aggiungi un tema. Esempio: /post vantaggi del nostro SaaS per HR");
    return;
  }
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  const system = buildSystemPrompt("post", user.tone);
  const reply = await callOpenAI({ system, user: text });
  await ctx.reply(wrapReply(reply));
});

bot.command("followup", async (ctx) => {
  if (!(await ensureOpenAIForCommand(ctx))) return;
  const text = ctx.message.text.replace("/followup", "").trim();
  if (!text) {
    await ctx.reply("Aggiungi un contesto. Esempio: /followup hai un aggiornamento sulla proposta? ");
    return;
  }
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  const system = buildSystemPrompt("followup", user.tone);
  const reply = await callOpenAI({ system, user: text });
  await ctx.reply(wrapReply(reply));
});

bot.command("task_add", async (ctx) => {
  const raw = ctx.message.text.replace("/task_add", "").trim();
  if (!raw) {
    await ctx.reply(
      "Usa /task_add <testo>. Opzioni: priorita [alta|media|bassa], scadenza [oggi|domani|YYYY-MM-DD], tag #marketing"
    );
    return;
  }

  const priority = parsePriority(raw);
  const tags = extractTags(raw);
  const clean = stripPriorityTokens(removeTags(raw));

  const dateMatch = clean.match(/\b(oggi|domani|\d{4}-\d{2}-\d{2})\b/i);
  const dueDate = dateMatch ? parseDateToken(dateMatch[1]) : null;
  const title = dateMatch
    ? clean.replace(dateMatch[1], "").replace(/\s{2,}/g, " ").trim()
    : clean;

  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));

  const task = {
    id: user.taskCounter,
    title: title || "Task",
    priority,
    dueDate: dueDate ? formatDateISO(dueDate) : null,
    tags,
    done: false,
    createdAt: new Date().toISOString()
  };

  user.tasks.push(task);
  user.taskCounter += 1;
  await writeState(state);

  await ctx.reply(`Aggiunta: [${task.id}] ${task.title} (${task.priority})`);
});

bot.command("task_list", async (ctx) => {
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  const openTasks = user.tasks.filter((task) => !task.done);
  await ctx.reply(formatTasks(openTasks));
});

bot.command("task_done", async (ctx) => {
  const raw = ctx.message.text.replace("/task_done", "").trim();
  const id = Number(raw);
  if (!id) {
    await ctx.reply("Usa /task_done <id>. Esempio: /task_done 3");
    return;
  }
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  const task = user.tasks.find((t) => t.id === id);
  if (!task) {
    await ctx.reply("Task non trovata.");
    return;
  }
  task.done = true;
  await writeState(state);
  await ctx.reply(`Completata: [${task.id}] ${task.title}`);
});

bot.command("task_today", async (ctx) => {
  const today = formatDateISO(new Date());
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  const tasks = user.tasks.filter(
    (task) => !task.done && task.dueDate === today
  );
  await ctx.reply(`Task di oggi:\n${formatTasks(tasks)}`);
});

bot.command("task_next", async (ctx) => {
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  const openTasks = user.tasks.filter((task) => !task.done);
  const sorted = openTasks.sort((a, b) => {
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });
  await ctx.reply(`Prossime task:\n${formatTasks(sorted.slice(0, 10))}`);
});

bot.command("dashboard", async (ctx) => {
  await startOAuthServer();
  await ctx.reply(`Apri la dashboard: ${getDashboardUrl()}`);
});

bot.command("morning_on", async (ctx) => {
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  user.morningDigestEnabled = true;
  await writeState(state);
  await ctx.reply(`Messaggio mattutino attivo alle ${user.morningDigestTime}.`);
});

bot.command("morning_off", async (ctx) => {
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  user.morningDigestEnabled = false;
  await writeState(state);
  await ctx.reply("Messaggio mattutino disattivato.");
});

bot.command("morning_time", async (ctx) => {
  const value = ctx.message.text.replace("/morning_time", "").trim();
  if (!isValidHHMM(value)) {
    await ctx.reply("Usa /morning_time HH:MM (esempio: /morning_time 08:15)");
    return;
  }

  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  user.morningDigestTime = value;
  await writeState(state);
  await ctx.reply(`Orario messaggio mattutino impostato a ${value}.`);
});

bot.command("morning_now", async (ctx) => {
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  try {
    await sendMorningDigestForUser(String(ctx.from.id), user);
    await ctx.reply("Messaggio mattutino di test inviato.");
  } catch {
    await ctx.reply("Non riesco a inviare il test ora. Verifica il collegamento Google con /gcal.");
  }
});

bot.command("morning_tomorrow", async (ctx) => {
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  try {
    await sendMorningDigestForUser(String(ctx.from.id), user, {
      targetDate: tomorrow,
      header: "Simulazione morning di domani:"
    });
    await ctx.reply("Simulazione di domani inviata.");
  } catch {
    await ctx.reply("Non riesco a inviare la simulazione. Verifica il collegamento Google con /gcal.");
  }
});

bot.command("gtasks_now", async (ctx) => {
  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));

  let info;
  try {
    info = await listGoogleOpenTasks(user, null);
  } catch {
    info = { connected: false, count: 0, items: [] };
  }

  if (!info.connected) {
    await ctx.reply("Google Tasks non collegato. Ricollega Google con /gcal.");
    return;
  }

  if (!info.count) {
    await ctx.reply("Nessuna task aperta su Google Tasks.");
    return;
  }

  const lines = info.items.map((t) => {
    const due = t.due ? ` | scad: ${new Date(t.due).toLocaleDateString("it-IT")}` : "";
    return `- ${t.title}${due} | ${t.listTitle}`;
  }).join("\n");

  await ctx.reply(`Google Tasks aperte (${info.count}):\n${lines}`);
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;
  if (!OPENAI_ENABLED) {
    await ctx.reply("Testo libero AI disattivato. Per ora uso /morning_now, /morning_tomorrow, task e calendario.");
    return;
  }

  const state = await readState();
  const user = getUserState(state, String(ctx.from.id));

  let events = [];
  const picked = extractDateFromText(text);
  const targetDate = picked?.date || new Date();
  const dateLabel = picked?.label || "oggi";
  try {
    const range = getDayRange(targetDate);
    events = await getCalendarEvents(user, range);
  } catch {
    events = [];
  }

  const tasks = user.tasks.filter((task) => !task.done).slice(0, 5);
  const eventsText = formatEventLines(events, {
    showCalendar: user.google?.calendarId === "all"
  });
  const tasksText = formatTasks(tasks);

  const system = [
    "Sei un assistente CEO+Creativo.",
    "Risposte concise, operative, niente fronzoli.",
    "Usa il contesto fornito. Non inventare eventi.",
    "Se mancano dati, chiedi una sola domanda di chiarimento."
  ].join(" ");

  const userMsg = [
    "Contesto:",
    `- Eventi (${dateLabel}): ${eventsText}`,
    `- Task aperte: ${tasksText}`,
    "",
    `Richiesta: ${text}`
  ].join("\n");

  const reply = await callOpenAI({ system, user: userMsg });
  await ctx.reply(wrapReply(reply));
});

bot.launch();
startMorningDigestScheduler();

startOAuthServer()
  .then(() => {
    console.log(`Dashboard attiva su ${getDashboardUrl()}`);
  })
  .catch((err) => {
    console.error("Errore avvio server dashboard:", err?.message || err);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
