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
  res.json({ status: "ok" });
});

app.post("/bridge", async (req, res) => {
  console.log("BRIDGE REQUEST BODY:", JSON.stringify(req.body));

  const numberA = req.body.numberA;
  const numberB = req.body.numberB;

  console.log("Number A:", numberA);
  console.log("Number B:", numberB);

  if (!numberA || !numberB) {
    console.log("MISSING NUMBERS");
    return res.status(400).json({ error: "Both numbers required" });
  }

  const roomName = "show_" + Date.now();
  const from = process.env.TWILIO_FROM_NUMBER;

  console.log("Room:", roomName);
  console.log("From:", from);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="" waitMethod="GET">${roomName}</Conference>
  </Dial>
</Response>`;

  try {
    console.log("Calling A:", numberA);
    const callA = await client.calls.create({
      to:    numberA,
      from:  from,
      twiml: twiml,
    });
    console.log("Call A SID:", callA.sid);

    console.log("Calling B:", numberB);
    const callB = await client.calls.create({
      to:    numberB,
      from:  from,
      twiml: twiml,
    });
    console.log("Call B SID:", callB.sid);

    res.json({
      success:  true,
      room:     roomName,
      callASid: callA.sid,
      callBSid: callB.sid,
    });

  } catch (err) {
    console.log("ERROR:", err.message);
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
  console.log("Bridge server on port " + PORT);
});
