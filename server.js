// server.js - FINAL VERSION (Có Login + Phân Quyền + Reset WiFi)
const express = require("express");
const bodyParser = require("body-parser");
const mqtt = require("mqtt");
const path = require("path");
const mongoose = require("mongoose");

const app = express();
app.use(bodyParser.json());
app.use(express.static(__dirname));

// ==================== 1. MONGO & SCHEMAS ====================
const mongoURI = process.env.MONGO_URI || "mongodb+srv://iot:FH29y9hfgRDpol2B@iot-cluster.hbgvh83.mongodb.net/?appName=iot-cluster";

mongoose.connect(mongoURI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.log("❌ MongoDB Error:", err));

// --- Schema Trạng Thái Bể Cá ---
const StateSchema = new mongoose.Schema({
  deviceId: { type: String, default: "aquarium_main", unique: true },
  
  // Điều khiển
  autoMode: { type: Number, default: 0 },
  pump: { type: Number, default: 0 },
  light: { type: Number, default: 0 },
  
  // Cảm biến
  temperature: { type: Number, default: 0 },
  distance_mm: { type: Number, default: 0 },
  waterLevel: { type: Number, default: 0 },
  
  // Thông tin mạng
  wifiSSID: { type: String, default: "Disconnect" },
  ip: { type: String, default: "0.0.0.0" },
  rssi: { type: Number, default: 0 },
  
  // Cài đặt
  threshold: { type: Number, default: 100 },
  lightSchedule: { on: { type: String, default: "18:00" }, off: { type: String, default: "06:00" } },
  lastUpdated: { type: Date, default: Date.now },
});

// --- Schema Tài Khoản (User) - MỚI ---
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'viewer' } // 'admin' hoặc 'viewer'
});

// --- Schema Log ---
const LogSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  source: String,
  action: String,
  key: String,
  value: mongoose.Mixed,
  message: String,
});

const State = mongoose.model("State", StateSchema);
const User = mongoose.model("User", UserSchema);
const Log = mongoose.model("Log", LogSchema);

// ==================== 2. KHỞI TẠO DỮ LIỆU ====================
// ==================== 2. KHỞI TẠO DỮ LIỆU ====================
async function initData() {
  // 1. Tạo state mặc định
  if (!(await State.findOne({ deviceId: "aquarium_main" }))) {
    await State.create({ deviceId: "aquarium_main" });
    console.log("🛠️ Created default device state");
  }

  // 2. CẬP NHẬT HOẶC TẠO ADMIN (Sửa đoạn này)
  // Dùng findOneAndUpdate để: Nếu chưa có thì tạo, nếu có rồi thì sửa lại quyền thành 'admin'
  await User.findOneAndUpdate(
      { username: "admin" }, 
      { 
          $set: { 
              password: "123", 
              role: "admin" // <--- Dòng quan trọng: Ép quyền thành admin
          } 
      },
      { upsert: true, new: true }
  );
  console.log("👑 Đã cập nhật/khôi phục tài khoản: admin / 123 (Quyền: Admin)");
}
initData();

// ==================== 3. HỆ THỐNG XÁC THỰC (AUTH) ====================
const SESSIONS = {}; // Lưu token tạm thời (Token -> Role)

const generateToken = () => Math.random().toString(36).substring(2) + Date.now().toString(36);

// Middleware: Chặn nếu không phải Admin
const requireAdmin = (req, res, next) => {
    const token = req.headers['authorization'];
    if (SESSIONS[token] && SESSIONS[token] === 'admin') {
        next(); // Cho qua
    } else {
        res.status(403).json({ success: false, error: "⛔ Bạn không có quyền Admin!" });
    }
};

// API Đăng nhập
app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username, password });
        if (user) {
            const token = generateToken();
            SESSIONS[token] = user.role; // Lưu quyền vào session
            res.json({ success: true, token, role: user.role, username: user.username });
            console.log(`👤 Login: ${username} (${user.role})`);
        } else {
            res.json({ success: false, error: "Sai tên đăng nhập hoặc mật khẩu" });
        }
    } catch (e) { res.status(500).json({ success: false, error: "Lỗi Server" }); }
});

// API Tạo tài khoản mới (Chỉ Admin mới được dùng)
app.post("/register", requireAdmin, async (req, res) => {
    const { newUsername, newPassword, newRole } = req.body;
    
    if (!newUsername || !newPassword) return res.json({ success: false, error: "Thiếu thông tin" });

    try {
        const exists = await User.findOne({ username: newUsername });
        if (exists) return res.json({ success: false, error: "Tên đăng nhập đã tồn tại" });
        
        await User.create({ username: newUsername, password: newPassword, role: newRole });
        res.json({ success: true, message: `Đã tạo user: ${newUsername} (${newRole})` });
        console.log(`✨ New User: ${newUsername} (${newRole})`);
    } catch(e) { res.status(500).json({success: false, error: e.message}); }
});

// ==================== 4. MQTT & DEVICE CONTROL ====================
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
  console.log("✅ MQTT Connected");
  mqttClient.subscribe("fish/tele");
  mqttClient.subscribe("fish/aquarium_main/status");
  mqttClient.subscribe("fish/button/#");
});

// Hàm cập nhật DB và gửi MQTT
async function updateDevice(key, value, source = "unknown") {
  const state = await State.findOne({ deviceId: "aquarium_main" });
  if (!state) return false;
  state[key] = value;
  state.lastUpdated = new Date();
  await state.save();

  // Gửi lệnh xuống ESP
  mqttClient.publish(`fish/cmd/${key}`, String(value));

  // Ghi log
  await Log.create({
    source, action: "update", key, value, 
    message: `${source.toUpperCase()}: ${key} → ${value}`
  });
  return true;
}

// Xử lý tin nhắn từ ESP
mqttClient.on("message", async (topic, message) => {
  const msg = message.toString().trim();

  // 1. Nhận thông tin cảm biến & WiFi
  if (topic === "fish/tele" || topic === "fish/aquarium_main/status") {
    try {
      const data = JSON.parse(msg);
      const updates = {};
      
      if (data.temperature !== undefined) updates.temperature = data.temperature;
      if (data.dist !== undefined) updates.distance_mm = data.dist; // map cũ
      if (data.waterLevel !== undefined) updates.waterLevel = data.waterLevel;
      
      if (data.autoMode !== undefined) updates.autoMode = data.autoMode;
      if (data.pump !== undefined) updates.pump = data.pump;
      if (data.light !== undefined) updates.light = data.light;
      
      // WiFi Info
      if (data.wifiSSID) updates.wifiSSID = data.wifiSSID;
      if (data.ip) updates.ip = data.ip;
      if (data.rssi) updates.rssi = data.rssi;

      if (Object.keys(updates).length > 0) {
        updates.lastUpdated = new Date();
        await State.updateOne({ deviceId: "aquarium_main" }, { $set: updates }, { upsert: true });
      }
    } catch (e) { console.error("MQTT Parse Error", e.message); }
  }
  
  // 2. Nhận nút bấm vật lý (fish/button/pump...)
  else if (topic.startsWith("fish/button/")) {
      const key = topic.split("/")[2];
      const s = await State.findOne({ deviceId: "aquarium_main" });
      
      // Logic: Nếu Auto đang bật thì không cho chỉnh tay (trừ nút Auto)
      if (s && (s.autoMode !== 1 || key === 'autoMode')) {
         const newVal = s[key] ? 0 : 1;
         await updateDevice(key, newVal, "button");
      }
  }
});

// ==================== 5. API ĐIỀU KHIỂN (CẦN QUYỀN ADMIN) ====================

// API Cập nhật thiết bị (Bơm, Đèn...)
app.post("/update", requireAdmin, async (req, res) => {
  try {
    const updates = req.body;
    for (const [key, val] of Object.entries(updates)) {
      if (key === "lightSchedule" || key === "threshold") {
        await State.updateOne({ deviceId: "aquarium_main" }, { $set: { [key]: val } });
      } else {
        await updateDevice(key, val, "web");
      }
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// API Reset WiFi
app.post("/reset-wifi", requireAdmin, async (req, res) => {
  try {
    console.log("⚠️ Admin requesting WiFi Reset...");
    if (mqttClient.connected) {
      mqttClient.publish("fish/aquarium_main/set", "RESET_WIFI");
      await State.updateOne({ deviceId: "aquarium_main" }, { $set: { wifiSSID: "Reseting...", ip: "..." } });
      res.json({ success: true, message: "Lệnh Reset đã được gửi!" });
    } else {
      res.status(500).json({ success: false, error: "Mất kết nối MQTT" });
    }
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ==================== 6. PUBLIC API (KHÔNG CẦN QUYỀN) ====================
app.get("/state", async (req, res) => {
  const s = await State.findOne({ deviceId: "aquarium_main" });
  res.json(s || {});
});

app.get("/log", async (req, res) => {
  const logs = await Log.find().sort({ timestamp: -1 }).limit(50);
  res.json(logs);
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ==================== 7. AUTO LOGIC ====================
setInterval(async () => {
  try {
    const s = await State.findOne({ deviceId: "aquarium_main" });
    if (!s || s.autoMode !== 1) return;

    const now = new Date();
    const h = (now.getUTCHours() + 7) % 24;
    const time = `${String(h).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;

    if (s.lightSchedule) {
      if (time === s.lightSchedule.on && s.light === 0) await updateDevice("light", 1, "auto");
      if (time === s.lightSchedule.off && s.light === 1) await updateDevice("light", 0, "auto");
    }
    // Logic bơm
    if (s.waterLevel < s.threshold && s.pump === 0) await updateDevice("pump", 1, "auto");
    else if (s.waterLevel >= s.threshold && s.pump === 1) await updateDevice("pump", 0, "auto");
    
  } catch (e) { console.error("Auto error:", e); }
}, 60000);

// ==================== 8. START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));