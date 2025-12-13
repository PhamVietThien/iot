// server.js - FINAL VERSION (Có Login + Thống Kê + Monitor Auto)
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

// --- Schema Trạng Thái Hiện Tại ---
const StateSchema = new mongoose.Schema({
  deviceId: { type: String, default: "aquarium_main", unique: true },
  autoMode: { type: Number, default: 0 },
  pump: { type: Number, default: 0 },
  light: { type: Number, default: 0 },
  temperature: { type: Number, default: 0 },
  distance_mm: { type: Number, default: 0 },
  waterLevel: { type: Number, default: 0 },
  wifiSSID: { type: String, default: "Disconnect" },
  ip: { type: String, default: "0.0.0.0" },
  rssi: { type: Number, default: 0 },
  threshold: { type: Number, default: 100 },
  lightSchedule: { on: { type: String, default: "18:00" }, off: { type: String, default: "06:00" } },
  lastUpdated: { type: Date, default: Date.now },
});

// --- Schema User ---
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'viewer' }
});

// --- Schema Log (Dùng để đếm số lần bật tắt) ---
const LogSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  source: String,
  action: String,
  key: String,
  value: mongoose.Mixed,
  message: String,
});

// --- Schema History (MỚI: Dùng để tính trung bình nhiệt độ/mực nước) ---
const HistorySchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now },
    temperature: Number,
    waterLevel: Number
});

const State = mongoose.model("State", StateSchema);
const User = mongoose.model("User", UserSchema);
const Log = mongoose.model("Log", LogSchema);
const History = mongoose.model("History", HistorySchema);

// ==================== 2. KHỞI TẠO DỮ LIỆU ====================
async function initData() {
  if (!(await State.findOne({ deviceId: "aquarium_main" }))) {
    await State.create({ deviceId: "aquarium_main" });
  }
  await User.findOneAndUpdate(
      { username: "admin" }, 
      { $set: { password: "123", role: "admin" } },
      { upsert: true, new: true }
  );
}
initData();

// ==================== 3. AUTH SYSTEM ====================
const SESSIONS = {}; 
const generateToken = () => Math.random().toString(36).substring(2) + Date.now().toString(36);

const requireAdmin = (req, res, next) => {
    const token = req.headers['authorization'];
    if (SESSIONS[token] && SESSIONS[token] === 'admin') next();
    else res.status(403).json({ success: false, error: "⛔ Bạn không có quyền Admin!" });
};

app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username, password });
    if (user) {
        const token = generateToken();
        SESSIONS[token] = user.role;
        res.json({ success: true, token, role: user.role, username: user.username });
    } else {
        res.json({ success: false, error: "Sai tên đăng nhập hoặc mật khẩu" });
    }
});

app.post("/register", requireAdmin, async (req, res) => {
    const { newUsername, newPassword, newRole } = req.body;
    try {
        const exists = await User.findOne({ username: newUsername });
        if (exists) return res.json({ success: false, error: "Tên tồn tại" });
        await User.create({ username: newUsername, password: newPassword, role: newRole });
        res.json({ success: true, message: `Đã tạo: ${newUsername}` });
    } catch(e) { res.status(500).json({success: false, error: e.message}); }
});

// ==================== 4. MQTT & DEVICE CONTROL ====================
const mqttClient = mqtt.connect(
  "mqtts://6df16538873d4a909d0cfb6afbad9517.s1.eu.hivemq.cloud:8883",
  { username: "iot_nhom8", password: "Iot123456789", rejectUnauthorized: false, reconnectPeriod: 2000 }
);

mqttClient.on("connect", () => {
  console.log("✅ MQTT Connected");
  mqttClient.subscribe("fish/tele");
  mqttClient.subscribe("fish/aquarium_main/status");
  mqttClient.subscribe("fish/button/#");
});

async function updateDevice(key, value, source = "unknown") {
  const state = await State.findOne({ deviceId: "aquarium_main" });
  if (!state) return false;
  state[key] = value;
  state.lastUpdated = new Date();
  await state.save();
  mqttClient.publish(`fish/cmd/${key}`, String(value));
  
  // Chỉ ghi Log khi có sự thay đổi trạng thái điều khiển
  await Log.create({
    source, action: "update", key, value, 
    message: `${source.toUpperCase()}: ${key} → ${value}`
  });
  return true;
}

// Biến check để không spam Database History
let lastHistorySave = 0;

// --- XỬ LÝ MQTT (ĐÃ NÂNG CẤP ĐỂ FIX LỖI) ---
mqttClient.on("message", async (topic, message) => {
  const msg = message.toString().trim();
  console.log(`📩 MQTT Nhận [${topic}]:`, msg); // <--- In ra để kiểm tra

  // 1. Nhận thông tin cảm biến (Tele)
  if (topic === "fish/tele" || topic === "fish/aquarium_main/status") {
    try {
      const data = JSON.parse(msg);
      const updates = {};
      
      // --- MAP DỮ LIỆU LINH HOẠT (Chấp nhận nhiều tên biến khác nhau) ---
      
      // 1. Nhiệt độ (chấp nhận: temperature, temp, t)
      const rawTemp = data.temperature ?? data.temp ?? data.t;
      if (rawTemp !== undefined) updates.temperature = parseFloat(rawTemp);

      // 2. Khoảng cách đo được (chấp nhận: distance, dist, d)
      const rawDist = data.distance ?? data.dist ?? data.distance_mm ?? data.d;
      if (rawDist !== undefined) updates.distance_mm = parseFloat(rawDist);

      // 3. Mực nước (QUAN TRỌNG: Tự tính nếu ESP không gửi)
      // Nếu ESP gửi trực tiếp waterLevel thì lấy, nếu không thì tính: 
      // Mực nước = (Chiều cao bể - Khoảng cách đo). Giả sử bể cao 200mm.
      const TANK_HEIGHT = 200; 
      if (data.waterLevel !== undefined) {
          updates.waterLevel = parseFloat(data.waterLevel);
      } else if (rawDist !== undefined) {
          // Tự tính toán mực nước dựa trên cảm biến siêu âm
          let calcLevel = TANK_HEIGHT - parseFloat(rawDist); 
          if(calcLevel < 0) calcLevel = 0; // Không để âm
          updates.waterLevel = calcLevel;
      }

      // 4. Các thông số khác
      if (data.autoMode !== undefined) updates.autoMode = data.autoMode;
      if (data.pump !== undefined) updates.pump = data.pump;
      if (data.light !== undefined) updates.light = data.light;
      if (data.wifiSSID) updates.wifiSSID = data.wifiSSID;
      if (data.ip) updates.ip = data.ip;
      if (data.rssi) updates.rssi = data.rssi;

      // --- CẬP NHẬT VÀO DB ---
      if (Object.keys(updates).length > 0) {
        updates.lastUpdated = new Date();
        await State.updateOne({ deviceId: "aquarium_main" }, { $set: updates }, { upsert: true });

        // LOGGING ĐỂ KIỂM TRA
        console.log("✅ Đã cập nhật trạng thái:", updates);

        // --- LƯU LỊCH SỬ THỐNG KÊ ---
        const now = Date.now();
        if (now - lastHistorySave > 10 * 60 * 1000) { // 10 phút/lần
            if(updates.temperature || updates.waterLevel) {
                // Lấy lại state mới nhất để đảm bảo có đủ dữ liệu
                const currentState = await State.findOne({ deviceId: "aquarium_main" });
                await History.create({
                    temperature: currentState.temperature,
                    waterLevel: currentState.waterLevel
                });
                console.log("📉 Saved History Data point");
                lastHistorySave = now;
            }
        }
      }
    } catch (e) { console.error("❌ Lỗi parse JSON MQTT:", e.message); }
  }
  
  // 2. Xử lý nút bấm vật lý (Logic giữ nguyên)
  else if (topic.startsWith("fish/button/")) {
      const key = topic.split("/")[2]; // Lấy pump, light, autoMode
      console.log("🔘 Nút vật lý bấm:", key);
      
      const s = await State.findOne({ deviceId: "aquarium_main" });
      // Logic chặn nút nếu đang Auto (như đã làm trước đó)
      if (s && s.autoMode === 1 && key !== 'autoMode') {
          console.log("⛔ Bỏ qua nút bấm do đang Auto Mode");
          return; 
      }
      
      if (s) {
         const newVal = s[key] ? 0 : 1;
         await updateDevice(key, newVal, "button");
      }
  }
});

// ==================== 5. API ĐIỀU KHIỂN (CẦN QUYỀN ADMIN) ====================
app.post("/update", requireAdmin, async (req, res) => {
  try {
    const updates = req.body;
    
    // --- ĐOẠN MỚI THÊM: KIỂM TRA AUTO MODE ---
    // Lấy trạng thái hiện tại
    const currentState = await State.findOne({ deviceId: "aquarium_main" });
    
    // Nếu đang Auto Mode = 1 VÀ người dùng đang cố điều khiển Bơm hoặc Đèn (mà không phải lệnh tắt Auto)
    if (currentState && currentState.autoMode === 1 && updates.autoMode === undefined) {
        if (updates.pump !== undefined || updates.light !== undefined) {
            return res.json({ success: false, error: "⚠️ Đang ở chế độ Tự Động (Auto)! Vui lòng tắt Auto trước khi điều khiển thủ công." });
        }
    }
    // ------------------------------------------

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

app.post("/reset-wifi", requireAdmin, async (req, res) => {
    if (mqttClient.connected) {
      mqttClient.publish("fish/aquarium_main/set", "RESET_WIFI");
      await State.updateOne({ deviceId: "aquarium_main" }, { $set: { wifiSSID: "Reseting...", ip: "..." } });
      res.json({ success: true });
    } else res.status(500).json({ success: false, error: "Mất kết nối MQTT" });
});

// ==================== 6. PUBLIC API & STATS ====================
app.get("/state", async (req, res) => {
  const s = await State.findOne({ deviceId: "aquarium_main" });
  res.json(s || {});
});

// API THỐNG KÊ (MỚI)
app.get("/stats", async (req, res) => {
    try {
        const now = new Date();
        const startOfDay = new Date(now.setHours(0,0,0,0));
        const startOfMonth = new Date(now.setDate(1));

        // 1. Đếm số lần bật
        const countPumpDay = await Log.countDocuments({ key: "pump", value: 1, timestamp: { $gte: startOfDay } });
        const countPumpMonth = await Log.countDocuments({ key: "pump", value: 1, timestamp: { $gte: startOfMonth } });
        
        const countLightDay = await Log.countDocuments({ key: "light", value: 1, timestamp: { $gte: startOfDay } });
        const countLightMonth = await Log.countDocuments({ key: "light", value: 1, timestamp: { $gte: startOfMonth } });

        // 2. Tính trung bình cảm biến (Dùng Aggregation)
        async function getAvg(field, dateFilter) {
            const result = await History.aggregate([
                { $match: { timestamp: { $gte: dateFilter } } },
                { $group: { _id: null, avgVal: { $avg: `$${field}` } } }
            ]);
            return result.length > 0 ? Math.round(result[0].avgVal * 10) / 10 : 0;
        }

        const avgTempDay = await getAvg("temperature", startOfDay);
        const avgTempMonth = await getAvg("temperature", startOfMonth);
        const avgWaterDay = await getAvg("waterLevel", startOfDay);
        const avgWaterMonth = await getAvg("waterLevel", startOfMonth);

        res.json({
            day: { pump: countPumpDay, light: countLightDay, temp: avgTempDay, water: avgWaterDay },
            month: { pump: countPumpMonth, light: countLightMonth, temp: avgTempMonth, water: avgWaterMonth }
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// --- API TRA CỨU LỊCH SỬ (MỚI) ---
app.post("/search-history", async (req, res) => {
  try {
      const { type, value } = req.body; // type: 'date' hoặc 'month', value: '2023-10-25' hoặc '2023-10'
      
      let startTime, endTime;
      const dateVal = new Date(value);

      if (type === 'date') {
          // Nếu chọn Ngày: Từ 00:00:00 đến 23:59:59 của ngày đó
          startTime = new Date(dateVal.setHours(0,0,0,0));
          endTime = new Date(dateVal.setHours(23,59,59,999));
      } else {
          // Nếu chọn Tháng: Từ ngày 1 đến ngày cuối cùng của tháng
          startTime = new Date(dateVal.getFullYear(), dateVal.getMonth(), 1);
          endTime = new Date(dateVal.getFullYear(), dateVal.getMonth() + 1, 0, 23, 59, 59);
      }

      // 1. Đếm số lần bật (Query Log)
      const countPump = await Log.countDocuments({ key: "pump", value: 1, timestamp: { $gte: startTime, $lte: endTime } });
      const countLight = await Log.countDocuments({ key: "light", value: 1, timestamp: { $gte: startTime, $lte: endTime } });

      // 2. Tính trung bình (Query History)
      const avgResult = await History.aggregate([
          { $match: { timestamp: { $gte: startTime, $lte: endTime } } },
          { 
              $group: { 
                  _id: null, 
                  avgTemp: { $avg: "$temperature" },
                  avgWater: { $avg: "$waterLevel" }
              } 
          }
      ]);

      const avgs = avgResult.length > 0 ? avgResult[0] : { avgTemp: 0, avgWater: 0 };

      res.json({
          success: true,
          pump: countPump,
          light: countLight,
          temp: Math.round(avgs.avgTemp * 10) / 10,
          water: Math.round(avgs.avgWater * 10) / 10
      });

  } catch (e) {
      res.status(500).json({ success: false, error: e.message });
  }
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
    
    // Logic bơm: Thấp hơn ngưỡng -> Bơm
    if (s.waterLevel < s.threshold && s.pump === 0) await updateDevice("pump", 1, "auto");
    else if (s.waterLevel >= s.threshold && s.pump === 1) await updateDevice("pump", 0, "auto");
    
  } catch (e) { console.error("Auto error:", e); }
}, 60000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));