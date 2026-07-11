/**
 * AI Studio Image Generator & Game Helper
 * ---------------------------------------------------
 * Created & Maintained by: Khaled
 * GitHub: https://github.com/YOUR_GITHUB_USERNAME
 * ---------------------------------------------------
 * This project is open-source. Please respect the original creator
 * by keeping the attribution links intact in the UI and code.
 */

import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------- Settings (all overridable from env) ---------- */
const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || "gemini-3.1-flash-image";
const CHAT_MODEL = process.env.CHAT_MODEL || "gemini-2.5-flash";
const MAX_IMAGES_PER_STUDENT = Number(process.env.MAX_IMAGES_PER_STUDENT || 5);
const MAX_IMAGES_PER_SESSION = Number(process.env.MAX_IMAGES_PER_SESSION || 400);
const MAX_CHATS_PER_STUDENT = Number(process.env.MAX_CHATS_PER_STUDENT || 40);
const TEACHER_KEY = process.env.TEACHER_KEY || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const MAX_PROMPT_LENGTH = 300;

/* ---------- API Initialization ---------- */
if (!process.env.GEMINI_API_KEY) {
  console.error("CRITICAL ERROR: GEMINI_API_KEY is missing in your .env file.");
  console.error("Please get an API key from Google AI Studio and add it.");
  process.exit(1);
}
// Standard initialization using simple API Key (No Vertex/Cloud config needed)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/* ---------- Refuse weak/default keys ---------- */
const WEAK_KEYS = new Set(["", "changeme", "admin-changeme", "admin", "password", "123456", "1234", "12345678"]);
const ADMIN_ENABLED = !WEAK_KEYS.has(ADMIN_KEY) && ADMIN_KEY.length >= 10;
const TEACHER_ENABLED = !WEAK_KEYS.has(TEACHER_KEY) && TEACHER_KEY.length >= 10;
if (!ADMIN_ENABLED) console.warn("ADMIN_KEY missing/weak (need 10+ chars) — admin mode is DISABLED.");
if (!TEACHER_ENABLED) console.warn("TEACHER_KEY missing/weak (need 10+ chars) — teacher reset is DISABLED.");

/* ---------- Simple in-memory counters ---------- */
const studentCounts = new Map();
const chatCounts = new Map(); 
let sessionCount = 0;

/* ---------- Workshop controls ---------- */
let paused = false;
let shutdown = false; 
let gameChatLocked = process.env.GAME_CHAT_OPEN !== "1";
let maxActiveStudents = Number(process.env.MAX_ACTIVE_STUDENTS || 60);
const ACTIVE_WINDOW_MS = 5 * 60 * 1000; 
const lastSeen = new Map(); 

function activeStudents() {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  let n = 0;
  for (const [id, t] of lastSeen) {
    if (t >= cutoff) n++;
    else lastSeen.delete(id);
  }
  return n;
}

/* ---------- Memory cleanup ---------- */
const DAY_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of lastSeen) {
    if (now - t > DAY_MS) { lastSeen.delete(id); studentCounts.delete(id); chatCounts.delete(id); }
  }
  if (studentCounts.size > 5000) studentCounts.clear();
  if (chatCounts.size > 5000) chatCounts.clear();
  for (const [ip, rec] of loginAttempts) {
    if (rec.until && now > rec.until) loginAttempts.delete(ip);
    else if (!rec.until && rec.count === 0) loginAttempts.delete(ip);
  }
}, 60 * 60 * 1000);

const STALE_STUDENT_MS = 24 * 60 * 60 * 1000; 
const studentLastRequest = new Map(); 

/* ---------- Content filter ---------- */
const BANNED_WORDS = [
  "gun", "weapon", "kill", "blood", "gore", "naked", "nude", "sexy", "drug", "knife",
  "سلاح", "مسدس", "دم", "قتل", "عاري", "مخدرات", "سكين",
];
function isPromptSafe(text) {
  const lower = text.toLowerCase();
  return !BANNED_WORDS.some((w) => lower.includes(w.toLowerCase()));
}

/* ---------- Gibberish check ---------- */
function isMeaningful(text) {
  const t = text.trim();
  const letters = t.match(/[a-zA-Z\u0600-\u06FF]/g) || [];
  if (letters.length < 3) return false;
  const symbolish = t.match(/[^a-zA-Z\u0600-\u06FF0-9\s]/g) || [];
  if (symbolish.length > t.length * 0.5) return false;
  const compact = t.replace(/\s+/g, "").toLowerCase();
  if (/^(.)\1+$/.test(compact)) return false;
  if (/^(..?.?)\1{2,}$/.test(compact)) return false;
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  const latinWords = words.filter((w) => /^[a-z]+$/.test(w));
  if (latinWords.length > 0) {
    const noVowel = latinWords.filter((w) => w.length >= 5 && !/[aeiouy]/.test(w));
    if (noVowel.length === latinWords.length && latinWords.length >= 1 && words.length === latinWords.length)
      return false;
  }
  const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "poiuytrewq", "lkjhgfdsa", "mnbvcxz"];
  const isRowRun = (w) => w.length >= 4 && ROWS.some((row) => row.includes(w));
  if (latinWords.length > 0 && latinWords.length === words.length && latinWords.every(isRowRun))
    return false;
  return true;
}

const GREETINGS = new Set([
  "hi", "hey", "yo", "hello", "hala", "salam",
  "هاي", "هلا", "اهلا", "أهلا", "مرحبا", "مرحبًا", "سلام", "السلام عليكم", "ازيك", "إزيك",
]);
function isGreeting(text) {
  const t = text.trim().toLowerCase().replace(/[!?.،]+$/g, "").trim();
  return GREETINGS.has(t);
}

function buildSafePrompt(userPrompt) {
  return (
    userPrompt +
    "\n\n(Keep the image appropriate for all ages: no sexual, explicit, gory, or graphically violent content.)"
  );
}

/* ---------- Generate Image ---------- */
async function generateImageBase64(fullPrompt) {
  if (MODEL.startsWith("imagen")) {
    const r = await ai.models.generateImages({
      model: MODEL,
      prompt: fullPrompt,
      config: { numberOfImages: 1, aspectRatio: "1:1" },
    });
    return { image: r?.generatedImages?.[0]?.image?.imageBytes || null, note: "" };
  }
  const r = await ai.models.generateContent({
    model: MODEL,
    contents: fullPrompt,
    config: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1" } },
  });
  const parts = r?.candidates?.[0]?.content?.parts || [];
  let image = null, note = "";
  for (const p of parts) {
    if (p?.inlineData?.data) image = p.inlineData.data;
    else if (p?.text) note += p.text;
  }
  return { image, note };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function generateWithRetry(fullPrompt, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await generateImageBase64(fullPrompt);
    } catch (err) {
      const status = err?.status || err?.code;
      const retryable = status === 429 || status === 503;
      lastErr = err;
      if (!retryable || i === tries - 1) throw err;
      const wait = 2000 * (i + 1) + Math.floor(Math.random() * 500); 
      console.log(`Rate-limited (attempt ${i + 1}/${tries}), retrying in ${wait}ms...`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/* ---------- Game Helper Chat ---------- */
const GAME_TUTOR_SYSTEM = `You are "Game Helper", a warm, encouraging coding mentor... (System prompt remains active)`;

async function generateChatReply(messages, tries = 3) {
  const contents = messages.map((m) => ({
    role: m.role === "model" ? "model" : "user",
    parts: [{ text: String(m.text || "").slice(0, 1200) }],
  }));
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await ai.models.generateContent({
        model: CHAT_MODEL,
        contents,
        config: {
          systemInstruction: GAME_TUTOR_SYSTEM,
          temperature: 0.7,
          maxOutputTokens: 700,
        },
      });
      const parts = r?.candidates?.[0]?.content?.parts || [];
      let text = "";
      for (const p of parts) if (p?.text) text += p.text;
      return text.trim();
    } catch (err) {
      const status = err?.status || err?.code;
      const retryable = status === 429 || status === 503;
      lastErr = err;
      if (!retryable || i === tries - 1) throw err;
      const wait = 2000 * (i + 1) + Math.floor(Math.random() * 500);
      console.log(`Chat rate-limited (attempt ${i + 1}/${tries}), retrying in ${wait}ms...`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/* ---------- App ---------- */
const app = express();
app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ ok: true, model: MODEL, sessionCount, maxImagesPerStudent: MAX_IMAGES_PER_STUDENT });
});

app.post("/status", (req, res) => {
  const studentId = (req.body?.studentId || "").toString().trim();
  const used = studentId ? (studentCounts.get(studentId) || 0) : 0;
  res.json({
    remaining: Math.max(0, MAX_IMAGES_PER_STUDENT - used),
    maxImagesPerStudent: MAX_IMAGES_PER_STUDENT,
    gameChatLocked,
  });
});

/* ---------- Timing-safe key comparison ---------- */
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const isAdminKey = (key) => ADMIN_ENABLED && safeEqual(key, ADMIN_KEY);
const isTeacherKey = (key) => TEACHER_ENABLED && safeEqual(key, TEACHER_KEY);

const loginAttempts = new Map(); 
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; 

app.post("/admin-login", (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "?";
  const rec = loginAttempts.get(ip) || { count: 0, until: 0 };

  if (Date.now() < rec.until)
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });

  const key = (req.body?.key || "").toString();
  const role = (req.body?.role || "admin").toString();

  const ok = role === "teacher" ? isTeacherKey(key) : isAdminKey(key);
  if (ok) {
    loginAttempts.delete(ip);
    return res.json({ ok: true, role });
  }

  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) { rec.until = Date.now() + LOCKOUT_MS; rec.count = 0; }
  loginAttempts.set(ip, rec);
  res.status(403).json({ error: role === "teacher" ? "Wrong teacher key" : "Wrong admin key" });
});

app.post("/generate", async (req, res) => {
  try {
    const prompt = (req.body?.prompt || "").toString().trim();
    const studentId = (req.body?.studentId || "").toString().trim();
    const adminKey = (req.body?.adminKey || "").toString();
    const isAdmin = isAdminKey(adminKey);
    const isTeacher = !isAdmin && isTeacherKey(adminKey);
    const isStaff = isAdmin || isTeacher;

    if (!prompt) return res.status(400).json({ error: "Type an idea first." });
    if (prompt.length > MAX_PROMPT_LENGTH)
      return res.status(400).json({ error: "That description is too long — keep it shorter." });
    if (!studentId) return res.status(400).json({ error: "Missing student id." });

    if (!isAdmin && !isMeaningful(prompt))
      return res.status(400).json({
        error: "I couldn't understand that. Try describing your idea in real words.",
      });

    const used = studentCounts.get(studentId) || 0;

    if (!isAdmin && !isPromptSafe(prompt))
      return res.status(400).json({ error: "That idea isn't allowed in the workshop — try another one." });

    if (shutdown && !isAdmin)
      return res.status(423).json({ error: "The system is currently switched off. Please contact the administrator." });

    if (!isAdmin) {
      if (maxActiveStudents > 0 && !lastSeen.has(studentId) && activeStudents() >= maxActiveStudents)
        return res.status(429).json({ error: "The studio is full right now — please wait for a free spot and try again." });
      lastSeen.set(studentId, Date.now());
    }

    if (!isStaff) {
      if (paused)
        return res.status(423).json({ error: "The workshop is paused right now. Please wait for your teacher." });

      if (sessionCount >= MAX_IMAGES_PER_SESSION)
        return res.status(429).json({ error: "The session image limit is used up. Ask your teacher." });
      if (used >= MAX_IMAGES_PER_STUDENT)
        return res.status(429).json({
          error: `You've reached your limit (${MAX_IMAGES_PER_STUDENT} images). Let a classmate have a turn.`,
          remaining: 0,
        });
    }

    const { image: imageBase64, note } = await generateWithRetry(buildSafePrompt(prompt));

    if (!imageBase64) {
      if (note) console.log("Model declined:", note.slice(0, 200));
      return res.status(422).json({
        error: "I couldn't make that one. Famous characters from movies usually can't be drawn.",
      });
    }

    if (!isStaff) {
      studentCounts.set(studentId, used + 1);
      sessionCount += 1;
    }

    res.json({
      image: `data:image/png;base64,${imageBase64}`,
      remaining: isStaff ? null : MAX_IMAGES_PER_STUDENT - (used + 1),
      unlimited: isStaff || undefined,
    });
  } catch (err) {
    console.error("Generate error:", err?.message || err);
    const status = err?.status || err?.code;
    if (status === 429)
      return res.status(429).json({ error: "Lots of classmates are creating right now — wait a few seconds and try again." });
    res.status(500).json({ error: "Temporary error — please try again." });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const studentId = (req.body?.studentId || "").toString().trim();
    const adminKey = (req.body?.adminKey || "").toString();
    const isAdmin = isAdminKey(adminKey);
    const isTeacher = !isAdmin && isTeacherKey(adminKey);
    const isStaff = isAdmin || isTeacher;

    if (gameChatLocked)
      return res.status(423).json({
        error: "Game Helper is locked right now.",
        locked: true,
      });

    if (!studentId) return res.status(400).json({ error: "Missing student id." });
    if (!messages.length) return res.status(400).json({ error: "Type a question first." });

    const lastUser = [...messages].reverse().find((m) => m.role !== "model");
    const prompt = (lastUser?.text || "").toString().trim();
    if (!prompt) return res.status(400).json({ error: "Type a question first." });
    if (prompt.length > 1000)
      return res.status(400).json({ error: "That message is too long — keep it shorter." });

    if (!isAdmin && !isMeaningful(prompt) && !isGreeting(prompt))
      return res.status(400).json({ error: "I couldn't understand that." });

    if (!isAdmin && !isPromptSafe(prompt))
      return res.status(400).json({ error: "That message isn't allowed in the workshop." });

    if (shutdown && !isAdmin)
      return res.status(423).json({ error: "The system is currently switched off." });

    if (!isAdmin) {
      if (maxActiveStudents > 0 && !lastSeen.has(studentId) && activeStudents() >= maxActiveStudents)
        return res.status(429).json({ error: "The studio is full right now." });
      lastSeen.set(studentId, Date.now());
    }

    const used = chatCounts.get(studentId) || 0;

    if (!isStaff) {
      if (paused)
        return res.status(423).json({ error: "The workshop is paused right now." });
      if (used >= MAX_CHATS_PER_STUDENT)
        return res.status(429).json({ error: `You've used all your questions.`, remaining: 0 });
    }

    const reply = await generateChatReply(messages.slice(-12));

    if (!reply)
      return res.status(422).json({ error: "I couldn't find an answer for that one." });

    if (!isStaff) chatCounts.set(studentId, used + 1);

    res.json({
      reply,
      remaining: isStaff ? null : MAX_CHATS_PER_STUDENT - (used + 1),
      unlimited: isStaff || undefined,
    });
  } catch (err) {
    console.error("Chat error:", err?.message || err);
    res.status(500).json({ error: "Temporary error — please try again." });
  }
});

function requireStaff(req, res) {
  const key = (req.body?.key || "").toString();
  if (isAdminKey(key) || isTeacherKey(key)) return true;
  res.status(403).json({ error: "Wrong key" });
  return false;
}

app.post("/control/pause", (req, res) => {
  if (!requireStaff(req, res)) return;
  paused = Boolean(req.body?.paused);
  res.json({ ok: true, paused });
});

app.post("/control/shutdown", (req, res) => {
  const key = (req.body?.key || "").toString();
  if (!isAdminKey(key)) return res.status(403).json({ error: "Admin key required" });
  shutdown = Boolean(req.body?.shutdown);
  res.json({ ok: true, shutdown });
});

app.post("/control/game-chat", (req, res) => {
  const key = (req.body?.key || "").toString();
  if (!isAdminKey(key)) return res.status(403).json({ error: "Admin key required" });
  gameChatLocked = Boolean(req.body?.locked);
  res.json({ ok: true, gameChatLocked });
});

app.post("/control/max-active", (req, res) => {
  if (!requireStaff(req, res)) return;
  const n = Number(req.body?.max);
  if (!Number.isFinite(n) || n < 0 || n > 1000)
    return res.status(400).json({ error: "Invalid max" });
  maxActiveStudents = Math.floor(n);
  res.json({ ok: true, maxActiveStudents });
});

app.post("/control/stats", (req, res) => {
  if (!requireStaff(req, res)) return;
  res.json({
    ok: true, paused, shutdown, gameChatLocked,
    maxActiveStudents, activeStudents: activeStudents(),
    sessionCount, maxImagesPerSession: MAX_IMAGES_PER_SESSION,
  });
});

app.post("/reset", (req, res) => {
  const key = (req.body?.key || "").toString();
  if (!isTeacherKey(key) && !isAdminKey(key))
    return res.status(403).json({ error: "Wrong key" });
  studentCounts.clear();
  chatCounts.clear();
  sessionCount = 0;
  res.json({ ok: true, message: "Counters reset." });
});

app.listen(PORT, () => {
  console.log(`AI Studio running on port ${PORT}`);
});
//