const express    = require("express");
const fs         = require("fs");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

const KEYS_FILE      = "keys.txt";      // Each line: KEYVALUE DURATION_MS  e.g. "ABC-1234 86400000"
const USERS_FILE     = "Users.txt";     // JSON: { "KEY": { "user": "token", "expiresAt": ms|null } }
const PREDICTOR_FILE = "predictor.txt"; // Script returned on success

/* ══════════════════════════════════════════
   FILE HELPERS
══════════════════════════════════════════ */

function readUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function readKeys() {
  try {
    const raw = fs.readFileSync(KEYS_FILE, "utf8");
    return raw
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const [key, duration] = l.split(/\s+/);
        return { key, duration: duration ? parseInt(duration) : null };
      });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

function writeKeys(entries) {
  const content = entries
    .map(e => e.duration != null ? `${e.key} ${e.duration}` : e.key)
    .join("\n");
  fs.writeFileSync(KEYS_FILE, content);
}

/* ══════════════════════════════════════════
   EXPIRY SWEEP — every 60s
   Removes expired entries from Users.txt
══════════════════════════════════════════ */

function sweepExpired() {
  try {
    const users   = readUsers();
    const now     = Date.now();
    let   changed = false;

    for (const [key, data] of Object.entries(users)) {
      if (data.expiresAt && now > data.expiresAt) {
        console.log(`[EXPIRED] ${key} — user: ${data.user}`);
        delete users[key];
        changed = true;
      }
    }

    if (changed) writeUsers(users);
  } catch (e) {
    console.error("[SWEEP ERROR]", e.message);
  }
}

sweepExpired();
setInterval(sweepExpired, 60 * 1000);

/* ══════════════════════════════════════════
   POST /check
   Body: { key, user }

   Logic:
   1. Check Users.txt — if key is already activated:
      - verify user matches
      - verify not expired
      - return script
   2. Check keys.txt — if key exists there:
      - activate it (bind to user + set expiry)
      - remove from keys.txt, add to Users.txt
      - return script
   3. Otherwise: invalid key

   Responses:
     200 { success: true,  script: "..." }
     403 { success: false, message: "..." }
     500 { success: false, message: "..." }
══════════════════════════════════════════ */

app.post("/check", (req, res) => {
  const { key, user } = req.body;

  if (!key || !user) {
    return res.status(400).json({ success: false, message: "Key and user are required." });
  }

  let users, keyEntries;
  try {
    users      = readUsers();
    keyEntries = readKeys();
  } catch (e) {
    console.error("[READ ERROR]", e);
    return res.status(500).json({ success: false, message: "Server error." });
  }

  const now = Date.now();

  // ── Already activated key ──
  const existing = users[key];
  if (existing) {

    // Wrong user trying to use someone else's key
    if (existing.user !== user) {
      return res.status(403).json({ success: false, message: "Key is linked to a different user." });
    }

    // Expired
    if (existing.expiresAt && now > existing.expiresAt) {
      delete users[key];
      try { writeUsers(users); } catch (e) {}
      return res.status(403).json({ success: false, message: "Key has expired." });
    }

    // Valid returning user — send script
    return sendScript(res);
  }

  // ── Unactivated key in keys.txt ──
  const keyEntry = keyEntries.find(e => e.key === key);
  if (!keyEntry) {
    return res.status(403).json({ success: false, message: "Invalid key." });
  }

  // Activate: bind to user, set expiry, move to Users.txt
  const expiresAt = keyEntry.duration != null ? now + keyEntry.duration : null;
  users[key] = { user, expiresAt, activatedAt: now };

  const updatedKeys = keyEntries.filter(e => e.key !== key);

  try {
    writeUsers(users);
    writeKeys(updatedKeys);
  } catch (e) {
    console.error("[WRITE ERROR]", e);
    return res.status(500).json({ success: false, message: "Server error." });
  }

  console.log(`[ACTIVATED] ${key} | user: ${user} | expires: ${expiresAt ? new Date(expiresAt).toISOString() : "never"}`);

  return sendScript(res);
});

function sendScript(res) {
  fs.readFile(PREDICTOR_FILE, "utf8", (err, script) => {
    if (err) {
      console.error("[PREDICTOR ERROR]", err);
      return res.status(500).json({ success: false, message: "Could not load script." });
    }
    return res.json({ success: true, script });
  });
}

/* ══════════════════════════════════════════
   START
══════════════════════════════════════════ */

app.listen(3000, () => {
  console.log("✅ CUDA server running on :3000");
});