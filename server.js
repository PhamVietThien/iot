// server.js - ĐÃ SỬA LỖI (FIXED)
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
  
  // --- THÔNG TIN WIFI ---
  wifiSSID: { type: String, default: "Disconnect" },
  ip: { type: String, default: "0.0.0.0" },
  rssi: { type: Number, default: 0 },
  // ----------------------

  distance_mm: { type: Number, default: 0 },
  waterLevel: { type: Number, default: 0 },
  threshold: { type: Number, default: 100 },
  lightSchedule: {
    on: { type: String, default: "18:00" },
    off: { type: String, default: "06:00" },
  },
  lastUpdated: { type: Date, default: Date.now },
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
  // Subscribe cả 2 topic cho chắc (đề phòng ESP code cũ hay mới)
  mqttClient.subscribe("fish/tele");
  mqttClient.subscribe("fish/aquarium_main/status"); // <--- Topic chuẩn của ESP mới
  mqttClient.subscribe("fish/button/#");
});

// ==================== 4. HÀM HỖ TRỢ ====================
async function canManualControl() {
  const s = await State.findOne({ deviceId: "aquarium_main" });
  return !s || s.autoMode !== 1;
}

async function updateDevice(key, value, source = "unknown") {
  const state = await State.findOne({ deviceId: "aquarium_main" });
  if (!state) return false;

  // Logic đếm số lần bật tắt (nếu cần) có thể thêm ở đây
  state[key] = value;
  state.lastUpdated = new Date(); // Sửa lại tên trường cho khớp schema
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

// ==================== 5. MQTT HANDLER (ĐÃ SỬA) ====================
mqttClient.on("message", async (topic, message) => {
  const msg = message.toString().trim();

  // 1. XỬ LÝ DỮ LIỆU CẢM BIẾN & WIFI
  // Chấp nhận cả topic cũ và mới
  if (topic === "fish/tele" || topic === "fish/aquarium_main/status") {
    try {
      const data = JSON.parse(msg);
      const updates = {};

      // Map dữ liệu từ JSON vào DB
      if (data.temperature !== undefined) updates.temperature = data.temperature;
      if (data.temp !== undefined) updates.temperature = data.temp; // Backup tên cũ
      
      if (data.dist !== undefined) {
        updates.distance_mm = data.dist;
        updates.waterLevel = Math.max(0, Math.min(200, data.dist));
      }
      
      if (data.autoMode !== undefined) updates.autoMode = data.autoMode;
      if (data.pump !== undefined) updates.pump = data.pump;
      if (data.light !== undefined) updates.light = data.light;

      // --- CẬP NHẬT WIFI INFO (MỚI) ---
      if (data.wifiSSID) updates.wifiSSID = data.wifiSSID;
      if (data.ip) updates.ip = data.ip;
      if (data.rssi) updates.rssi = data.rssi;
      // -------------------------------

      if (Object.keys(updates).length > 0) {
        updates.lastUpdated = new Date();
        await State.updateOne(
          { deviceId: "aquarium_main" },
          { $set: updates },
          { upsert: true }
        );
        // Log bớt spam lại, chỉ log khi cần thiết hoặc uncomment dòng dưới
        // console.log("Updated DB:", updates);
      }
    } catch (e) {
      console.error("MQTT Parse Error:", e.message);
    }
    return;
  }

  // 2. XỬ LÝ NÚT BẤM VẬT LÝ
  if (topic.startsWith("fish/button/")) {
    const key = topic.split("/")[2];

    if (key === "autoMode") {
      const state = await State.findOne({ deviceId: "aquarium_main" });
      const newVal = state.autoMode ? 0 : 1;
      await updateDevice("autoMode", newVal, "button");
      return;
    }

    if (!["light", "pump"].includes(key)) return;

    if (!(await canManualControl())) {
      console.log("Manual control blocked by Auto Mode");
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

// API Cập nhật trạng thái
app.post("/update", async (req, res) => {
  try {
    const updates = req.body;
    const allowed = await canManualControl();
    
    // Kiểm tra quyền manual
    const tryingManual = Object.keys(updates).some((k) =>
      ["light", "pump"].includes(k)
    );

    if (!allowed && tryingManual) {
      return res.status(403).json({
        success: false,
        error: "Đang ở chế độ AUTO. Vui lòng tắt Auto để điều khiển!",
      });
    }

    for (const [key, val] of Object.entries(updates)) {
      if (key === "lightSchedule") {
        await State.updateOne(
          { deviceId: "aquarium_main" },
          { $set: { lightSchedule: val, lastUpdated: new Date() } }
        );
      } else if (key === "threshold") {
        await State.updateOne(
          { deviceId: "aquarium_main" },
          { $set: { threshold: val, lastUpdated: new Date() } }
        );
      } else {
        // autoMode, pump, light gọi qua hàm chung để bắn MQTT
        await updateDevice(key, val, "web");
      }
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API Reset WiFi (ĐÃ SỬA TÊN BIẾN)
app.post("/reset-wifi", async (req, res) => {
  try {
    console.log("Web Admin requesting WiFi Reset...");
    
    // Sửa lỗi: dùng mqttClient thay vì client
    if (mqttClient.connected) {
      mqttClient.publish("fish/aquarium_main/set", "RESET_WIFI");
      
      // Cập nhật trạng thái trên DB để web hiện thị ngay
      await State.updateOne(
        { deviceId: "aquarium_main" }, 
        { $set: { wifiSSID: "Reseting...", ip: "..." } }
      );
      
      res.json({ success: true, message: "Lệnh Reset đã được gửi!" });
    } else {
      res.status(500).json({ success: false, error: "MQTT Broker chưa kết nối" });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================== 7. AUTO MODE LOOP ====================
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

    // Logic bơm theo mức nước (giả định threshold là mức cạn cần bơm)
    if (s.waterLevel < s.threshold && s.pump === 0)
      await updateDevice("pump", 1, "auto");
    else if (s.waterLevel >= s.threshold && s.pump === 1)
      await updateDevice("pump", 0, "auto");
      
  } catch (e) {
    console.error("Auto error:", e);
  }
}, 60000);

// ==================== 8. START SERVER ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});