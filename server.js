const express = require("express");
const cors    = require("cors");
const twilio  = require("twilio");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Bridge server running" });
});

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

    console.log(`🎭 BRIDGE FIRED — Room: ${roomName}`);

    res.json({
      success:  true,
      room:     roomName,
      callASid: callA.sid,
      callBSid: callB.sid,
    });

  } catch (err) {
    console.error("[ERROR]", err.message);
    res.status(500).json({ error: err.message });
  }
});

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
  console.log(`🎭 Bridge server live on port ${PORT}`);
});
