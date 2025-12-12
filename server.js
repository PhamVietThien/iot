// server.js - PHIÊN BẢN CUỐI CÙNG, HOÀN HẢO NHẤT (12/12/2025)
const express = require("express");
const bodyParser = require("body-parser");
const mqtt = require("mqtt");
const path = require("path");
const mongoose = require("mongoose");

const app = express();
app.use(bodyParser.json());
app.use(express.static(__dirname));

// ==================== 1. MONGO ====================
const mongoURI =
  process.env.MONGO_URI ||
  "mongodb+srv://iot:FH29y9hfgRDpol2B@iot-cluster.hbgvh83.mongodb.net/?appName=iot-cluster";

mongoose
  .connect(mongoURI)
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.log("MongoDB Error:", err));

// ==================== 2. SCHEMA ====================
const StateSchema = new mongoose.Schema({
  deviceId: { type: String, default: "aquarium_main", unique: true },

  autoMode: { type: Number, default: 0 },
  pump: { type: Number, default: 0 },
  light: { type: Number, default: 0 },

  temperature: { type: Number, default: 0 },
  distance_mm: { type: Number, default: 0 },
  waterLevel: { type: Number, default: 0 }, // 0-200mm
  threshold: { type: Number, default: 50 },

  lightSchedule: {
    on: { type: String, default: "07:00" },
    off: { type: String, default: "19:00" },
  },

  lightCount: { type: Number, default: 0 },
  pumpCount: { type: Number, default: 0 },
  lastUpdate: { type: Date, default: Date.now },
});

const LogSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  source: String,
  action: String,
  key: String,
  value: mongoose.Mixed,
  message: String,
});

const State = mongoose.model("State", StateSchema);
const Log = mongoose.model("Log", LogSchema);

// ==================== INIT DEFAULT STATE ====================
async function init() {
  const exists = await State.findOne({ deviceId: "aquarium_main" });
  if (!exists) {
    await State.create({ deviceId: "aquarium_main" });
    console.log("Created default state");
  }
}
init();

// ==================== 3. MQTT ====================
const mqttClient = mqtt.connect(
  "mqtts://6df16538873d4a909d0cfb6afbad9517.s1.eu.hivemq.cloud:8883",
  {
    username: "iot_nhom8",
    password: "Iot123456789",
    rejectUnauthorized: false,
    reconnectPeriod: 2000,
  }
);

mqttClient.on("connect", () => {
  console.log("MQTT Connected");
  mqttClient.subscribe("fish/tele");
  mqttClient.subscribe("fish/button/#");
});

// ==================== 4. HÀM HỖ TRỢ ====================
async function canManualControl() {
  const s = await State.findOne({ deviceId: "aquarium_main" });
  return !s || s.autoMode !== 1;
}

async function updateDevice(key, value, source = "unknown") {
  const state = await State.findOne({ deviceId: "aquarium_main" });
  if (!state || state[key] === value) return false;

  if ((key === "light" || key === "pump") && state[key] === 0 && value === 1) {
    state[key + "Count"] += 1;
  }

  state[key] = value;
  state.lastUpdate = new Date();
  await state.save();

  mqttClient.publish(`fish/cmd/${key}`, String(value));

  await Log.create({
    source,
    action: "update",
    key,
    value,
    message: `${source.toUpperCase()}: ${key} → ${value}`,
  });

  console.log(`[${source}] ${key} = ${value}`);
  return true;
}

// ==================== 5. MQTT HANDLER ====================
mqttClient.on("message", async (topic, message) => {
  const msg = message.toString().trim();

  // 1. Telemetry
  if (topic === "fish/tele") {
    try {
      const data = JSON.parse(msg);

      const updates = {};
      if (data.temp !== undefined) updates.temperature = data.temp;
      if (data.dist !== undefined) {
        updates.distance_mm = data.dist;
        updates.waterLevel = Math.max(0, Math.min(200, data.dist));
      }
      if (data.threshold !== undefined) updates.threshold = data.threshold;
      if (data.auto !== undefined) updates.autoMode = data.auto;

      if (Object.keys(updates).length > 0) {
        updates.lastUpdate = new Date();
        await State.updateOne(
          { deviceId: "aquarium_main" },
          { $set: updates }
        );

        await Log.create({
          source: "esp",
          action: "telemetry",
          message: "Cập nhật cảm biến",
          value: data,
        });
      }
    } catch (e) {
      console.error("Tele parse error:", e);
    }
    return;
  }

  // 2. BUTTON CONTROL
  if (topic.startsWith("fish/button/")) {
    const key = topic.split("/")[2];

    // Cho phép bật autoMode bằng nút vật lý
    if (key === "autoMode") {
      const state = await State.findOne({ deviceId: "aquarium_main" });
      const newVal = state.autoMode ? 0 : 1;
      await updateDevice("autoMode", newVal, "button");
      return;
    }

    // Chỉ xử lý nút light & pump
    if (!["light", "pump"].includes(key)) return;

    // Chặn nếu autoMode đang bật
    if (!(await canManualControl())) {
      await Log.create({
        source: "button",
        action: "blocked",
        key,
        message: "Nút vật lý bị chặn vì đang ở chế độ TỰ ĐỘNG",
      });
      return;
    }

    const state = await State.findOne({ deviceId: "aquarium_main" });
    const newVal = state[key] ? 0 : 1;
    await updateDevice(key, newVal, "button");
  }
});

// ==================== 6. API ====================
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "index.html"))
);

app.get("/state", async (req, res) => {
  const s = await State.findOne({ deviceId: "aquarium_main" });
  res.json(s || {});
});

app.get("/log", async (req, res) => {
  const logs = await Log.find().sort({ timestamp: -1 }).limit(100);
  res.json(logs);
});

app.post("/update", async (req, res) => {
  try {
    const updates = req.body;

    const allowed = await canManualControl();
    const tryingManual = Object.keys(updates).some((k) =>
      ["light", "pump"].includes(k)
    );

    if (!allowed && tryingManual) {
      return res.status(403).json({
        success: false,
        error: "Không được điều khiển đèn/bơm khi đang ở chế độ TỰ ĐỘNG!",
      });
    }

    for (const [key, val] of Object.entries(updates)) {
      if (key === "lightSchedule") {
        await State.updateOne(
          { deviceId: "aquarium_main" },
          { $set: { lightSchedule: val, lastUpdate: new Date() } }
        );
        await Log.create({
          source: "web",
          action: "schedule",
          message: "Cập nhật lịch đèn",
        });
      } else if (key === "autoMode") {
        await updateDevice("autoMode", val, "web");
      } else if (key === "threshold") {
        await State.updateOne(
          { deviceId: "aquarium_main" },
          { $set: { threshold: val, lastUpdate: new Date() } }
        );
        await Log.create({
          source: "web",
          action: "config",
          key,
          value: val,
        });
      } else if (["light", "pump"].includes(key)) {
        await updateDevice(key, val, "web");
      }
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================== 7. AUTO MODE ====================
setInterval(async () => {
  try {
    const s = await State.findOne({ deviceId: "aquarium_main" });
    if (!s || s.autoMode !== 1) return;

    const now = new Date();
    const h = (now.getUTCHours() + 7) % 24;
    const time = `${String(h).padStart(2, "0")}:${String(
      now.getUTCMinutes()
    ).padStart(2, "0")}`;

    if (s.lightSchedule) {
      if (time === s.lightSchedule.on && s.light === 0)
        await updateDevice("light", 1, "auto");

      if (time === s.lightSchedule.off && s.light === 1)
        await updateDevice("light", 0, "auto");
    }

    if (s.waterLevel < s.threshold && s.pump === 0)
      await updateDevice("pump", 1, "auto");
    else if (s.waterLevel >= s.threshold && s.pump === 1)
      await updateDevice("pump", 0, "auto");
  } catch (e) {
    console.error("Auto error:", e);
  }
}, 60000);

// ==================== 8. START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(
    `Giờ Việt Nam: ${new Date().toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
    })}`
  );
});
