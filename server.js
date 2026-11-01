const express = require("express");
const cors    = require("cors");
const twilio  = require("twilio");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(express.static(__dirname));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const FROM = "+14452942442";

// ── Trigger / reset words ─────────────────────────────────────────
const TRIGGER_WORD = "LINK";
const RESET_WORD   = "CLEAR";

// ── In-memory queue of numbers that texted LINK ───────────────────
// Note: resets if the server restarts. Fine for same-session use.
let queue = [];

function normalize(num) {
  return (num || "").trim();
}

// Turn any pasted format into E.164 for Kuwait.
// "6762 2229" / "66762229" (8-digit local)  -> "+965XXXXXXXX"
// "965XXXXXXXX" -> "+965XXXXXXXX"
// "00965XXXXXXXX" -> "+965XXXXXXXX"
// "+965 XXXX XXXX" -> "+965XXXXXXXX"
function cleanNumber(raw) {
  let n = (raw || "").replace(/[\s\-()]/g, ""); // strip spaces, dashes, parens
  if (n.startsWith("00")) n = "+" + n.slice(2);
  if (!n.startsWith("+")) {
    if (n.startsWith("965"))      n = "+" + n;
    else if (n.length === 8)      n = "+965" + n; // Kuwaiti domestic 8-digit
    else                          n = "+" + n;
  }
  return n;
}

// ── Health ────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", queued: queue.length });
});

// ── Twilio incoming SMS webhook ───────────────────────────────────
// Twilio POSTs here when a text arrives. Body: From, Body, etc.
app.post("/sms", (req, res) => {
  const from = normalize(req.body.From);
  const body = (req.body.Body || "").trim().toUpperCase();

  console.log("SMS IN:", from, "| body:", body);

  if (body.includes(RESET_WORD)) {
    queue = [];
    console.log("Queue CLEARED by", from);
  } else if (body.includes(TRIGGER_WORD)) {
    // Avoid duplicates: if this number already queued, drop the old one
    queue = queue.filter(n => n !== from);
    queue.push(from);
    console.log("Queued:", from, "| queue is now:", queue);
  } else {
    console.log("Ignored (no keyword):", from);
  }

  // Respond with empty TwiML so Twilio doesn't try to send an SMS back
  res.type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

// ── Check the queue (for the Shortcut's "Check" step) ─────────────
app.get("/queue", (req, res) => {
  const lastTwo = queue.slice(-2);
  res.json({
    count:   queue.length,
    ready:   lastTwo.length === 2,
    numbers: lastTwo,
  });
});

// ── Fire the two most recent queued numbers, then clear ───────────
app.post("/fire-queue", async (req, res) => {
  const lastTwo = queue.slice(-2);

  if (lastTwo.length < 2) {
    return res.status(400).json({ error: "Need 2 queued numbers, have " + lastTwo.length });
  }

  const numberA = lastTwo[0];
  const numberB = lastTwo[1];
  const roomName = "show_" + Date.now();

  console.log("FIRING QUEUE:", numberA, numberB);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="" waitMethod="GET">${roomName}</Conference>
  </Dial>
</Response>`;

  try {
    const callA = await client.calls.create({ to: numberA, from: FROM, twiml: twiml });
    console.log("Call A SID:", callA.sid);
    const callB = await client.calls.create({ to: numberB, from: FROM, twiml: twiml });
    console.log("Call B SID:", callB.sid);

    // Auto-clear after firing
    queue = [];

    res.json({
      success:  true,
      room:     roomName,
      bridged:  [numberA, numberB],
      callASid: callA.sid,
      callBSid: callB.sid,
    });
  } catch (err) {
    console.log("ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Manual clear endpoint (panic reset from Shortcut) ─────────────
app.post("/clear-queue", (req, res) => {
  queue = [];
  console.log("Queue cleared via /clear-queue");
  res.json({ success: true, count: 0 });
});

// ── Hang up ALL active calls (for the "End Bridge" Shortcut) ───────
// Ends every ringing/in-progress call on the account. No call IDs needed.
app.post("/end-everything", async (req, res) => {
  try {
    const ringing    = await client.calls.list({ status: "ringing", limit: 50 });
    const inProgress = await client.calls.list({ status: "in-progress", limit: 50 });
    const all = ringing.concat(inProgress);
    await Promise.all(all.map(c => client.calls(c.sid).update({ status: "completed" })));
    console.log("Ended", all.length, "active call(s)");
    res.json({ success: true, ended: all.length });
  } catch (err) {
    console.log("END ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Multi-number bridge (used by the webpage) ─────────────────────
app.post("/bridge-all", async (req, res) => {
  const raw = req.body.numbers;
  if (!Array.isArray(raw) || raw.length < 2) {
    return res.status(400).json({ error: "At least 2 numbers required" });
  }
  const numbers = raw.map(cleanNumber);
  const roomName = "show_" + Date.now();
  console.log("BRIDGE-ALL:", numbers);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="" waitMethod="GET">${roomName}</Conference>
  </Dial>
</Response>`;

  try {
    const callSids = [];
    for (const to of numbers) {
      const call = await client.calls.create({ to: to, from: FROM, twiml: twiml });
      callSids.push(call.sid);
    }
    res.json({ success: true, room: roomName, callSids: callSids, count: callSids.length });
  } catch (err) {
    console.log("BRIDGE-ALL ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── End specific calls (used by the webpage's "end + reset") ──────
app.post("/end-all", async (req, res) => {
  const callSids = req.body.callSids || [];
  try {
    await Promise.all(callSids.map(sid => client.calls(sid).update({ status: "completed" }).catch(() => null)));
    res.json({ success: true, ended: callSids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Original manual bridge (kept, unchanged) ──────────────────────
app.post("/bridge", async (req, res) => {
  let a = req.body.numberA;
  let b = req.body.numberB;

  // Allow a single "pair" field: both numbers, one per line (or comma-separated).
  if (req.body.pair) {
    const lines = String(req.body.pair).split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
    if (lines.length >= 2) {
      a = lines[0]; b = lines[1];
    } else {
      const parts = String(req.body.pair).split(/[,;]+|\s{2,}/).map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) { a = parts[0]; b = parts[1]; }
    }
  }

  if (!a || !b) {
    return res.status(400).json({ error: "Both numbers required" });
  }

  // Normalize pasted numbers (handles 8-digit local, 965..., spaces, etc.)
  const numberA = cleanNumber(a);
  const numberB = cleanNumber(b);
  console.log("BRIDGE:", a, "->", numberA, "|", b, "->", numberB);

  const roomName = "show_" + Date.now();
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="" waitMethod="GET">${roomName}</Conference>
  </Dial>
</Response>`;

  try {
    const callA = await client.calls.create({ to: numberA, from: FROM, twiml: twiml });
    const callB = await client.calls.create({ to: numberB, from: FROM, twiml: twiml });
    res.json({ success: true, room: roomName, callASid: callA.sid, callBSid: callB.sid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("Bridge server on port " + PORT);
});
