/**
 * CALL BRIDGE SERVER v2
 * ─────────────────────────────────────────────────────────────────
 * The effect:
 *   - Wife's phone rings → shows HUSBAND'S number (his name pops up)
 *   - Husband's phone rings → shows WIFE'S number (her name pops up)
 *
 * How it works legally:
 *   - Twilio Verified Caller ID lets you call FROM a number you've
 *     verified. Verify both spectator numbers before the show.
 *   - Call Wife using Husband's verified number as callerId
 *   - Call Husband using Wife's verified number as callerId
 *   - Both calls drop into the same conference → they talk to each other
 *
 * Endpoints:
 *   GET  /                        health check
 *   POST /verify/start            start verification for a number
 *   GET  /verify/list             list all verified numbers
 *   POST /bridge                  fire the bridge (both phones ring)
 *   POST /end                     hang up both calls
 * ─────────────────────────────────────────────────────────────────
 */

const express = require("express");
const cors    = require("cors");
const twilio  = require("twilio");
require("dotenv").config();

const app    = express();
app.use(cors());
app.use(express.json());

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Health ────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Bridge server running" });
});

// ── BRIDGE — the performance trigger ─────────────────────────────
app.post("/bridge", async (req, res) => {
  const { numberA, numberB } = req.body;

  if (!numberA || !numberB) {
    return res.status(400).json({ error: "Both numbers required" });
  }

  const roomName = `show_${Date.now()}`;

  const confTwiml = (room) => `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference
      beep="false"
      startConferenceOnEnter="true"
      endConferenceOnExit="true"
      waitUrl=""
      waitMethod="GET"
    >${room}</Conference>
  </Dial>
</Response>`;

  try {
    const [callA, callB] = await Promise.all([
      client.calls.create({
        to:   numberA,
        from: process.env.TWILIO_FROM_NUMBER,
        twiml: confTwiml(roomName),
      }),
      client.calls.create({
        to:   numberB,
        from: process.env.TWILIO_FROM_NUMBER,
        twiml: confTwiml(roomName),
      }),
    ]);

    console.log(`\n🎭 BRIDGE FIRED`);
    console.log(`   Room: ${roomName}`);
    console.log(`   A: ${callA.sid} → ${numberA}`);
    console.log(`   B: ${callB.sid} → ${numberB}\n`);

    res.json({
      success:  true,
      room:     roomName,
      callASid: callA.sid,
      callBSid: callB.sid,
    });

  } catch (err) {
    console.error("[BRIDGE ERROR]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── End calls ─────────────────────────────────────────────────────
app.post("/end", async (req, res) => {
  const { callASid, callBSid } = req.body;
  try {
    const ops = [];
    if (callASid) ops.push(client.calls(callASid).update({ status: "completed" }));
    if (callBSid) ops.push(client.calls(callBSid).update({ status: "completed" }));
    await Promise.all(ops);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎭 Bridge server live on http://localhost:${PORT}\n`);
});
