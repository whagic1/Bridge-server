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

// ── Check the queue (for the Shortcut's "Check" step) ────────────
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

// ── Original manual bridge (kept, unchanged) ──────────────────────
app.post("/bridge", async (req, res) => {
  const numberA = req.body.numberA;
  const numberB = req.body.numberB;

  if (!numberA || !numberB) {
    return res.status(400).json({ error: "Both numbers required" });
  }

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
