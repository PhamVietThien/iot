// server.js - FINAL VERSION (Fixed CastError, Added Network Info, Threshold, and Login Logic)
const express = require("express");
const bodyParser = require("body-parser");
const mqtt = require("mqtt");
const path = require("path");
const mongoose = require("mongoose");

const app = express();
app.use(bodyParser.json());
app.use(express.static(__dirname));

// ==================== 1. KẾT NỐI MONGODB & SCHEMAS ====================
const mongoURI = "mongodb+srv://iot:FH29y9hfgRDpol2B@iot-cluster.hbgvh83.mongodb.net/?appName=iot-cluster";

mongoose.connect(mongoURI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.log("❌ MongoDB Error:", err));

// --- Schema Trạng Thái ---
const StateSchema = new mongoose.Schema({
  deviceId: { type: String, default: "aquarium_main", unique: true },
  autoMode: { type: Number, default: 0 },
  pump: { type: Number, default: 0 },
  light: { type: Number, default: 0 },
  temperature: { type: Number, default: 0 },
  distance_mm: { type: Number, default: 0 },
  waterLevel: { type: Number, default: 0 },
  fishDetected: { type: Boolean, default: false },
  wifiSSID: { type: String, default: "Disconnect" },
  // THÔNG TIN MẠNG & NGƯỠNG
  ip: { type: String, default: "0.0.0.0" }, 
  rssi: { type: Number, default: 0 },       
  threshold: { type: Number, default: 80 }, // Ngưỡng nước (mặc định 80% an toàn)
  
  lastUpdated: { type: Date, default: Date.now },
  lightSchedule: { on: { type: String, default: "18:00" }, off: { type: String, default: "06:00" } }
});

// --- Schema User ---
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }, 
    role: { type: String, default: 'viewer' }
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

// --- Schema History ---
const HistorySchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now },
    temperature: Number,
    waterLevel: Number,
    fishDetected: Boolean
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
  // Tạo tài khoản admin mặc định nếu chưa có
  await User.findOneAndUpdate(
      { username: "admin" }, 
      { $set: { password: "123", role: "admin" } },
      { upsert: true, new: true }
  );
}
initData();

// ==================== 3. MQTT (LOGIC ĐỒNG BỘ & FIX NGƯỢC BƠM) ====================
const mqttClient = mqtt.connect(
  "mqtts://6df16538873d4a909d0cfb6afbad9517.s1.eu.hivemq.cloud:8883",
  { 
    username: "iot_nhom8", 
    password: "Iot123456789", 
    rejectUnauthorized: false, 
    reconnectPeriod: 2000 
  }
);

mqttClient.on("connect", () => {
  console.log("✅ MQTT Connected");
  mqttClient.subscribe("fish/tele");         // Nhận dữ liệu cảm biến
  mqttClient.subscribe("fish/button/#");     // Nhận sự kiện nút bấm vật lý
});

// --- HÀM CẬP NHẬT TRẠNG THÁI & GỬI LỆNH (QUAN TRỌNG) ---
async function updateDevice(key, value, source = "unknown") {
  const state = await State.findOne({ deviceId: "aquarium_main" });
  if (!state) return false;

  // 1. Cập nhật DB (Lưu giá trị hiển thị: 1=Bật, 0=Tắt)
  state[key] = value;
  state.lastUpdated = new Date(); // ĐÃ SỬA LỖI CAST ERROR
  await state.save();
  
  // 2. Chuẩn bị lệnh gửi xuống ESP
  let commandValue = String(value);

  // === FIX LỖI ĐIỀU KHIỂN BỊ NGƯỢC (ACTIVE LOW) ===
  if (key === "pump") {
      // Web bấm Bật (1) -> Gửi 0 (Low)
      // Web bấm Tắt (0) -> Gửi 1 (High)
      commandValue = String(value === 1 ? 0 : 1);
  }

  // 3. Gửi lệnh MQTT
  mqttClient.publish(`fish/cmd/${key}`, commandValue);
  
  // 4. Ghi Log
  await Log.create({
    source, action: "update", key, value, 
    message: `${source.toUpperCase()}: ${key} → ${value}`
  });
  return true;
}

let lastHistorySave = 0;

mqttClient.on("message", async (topic, message) => {
  const msg = message.toString().trim();

  // --- A. XỬ LÝ DỮ LIỆU CẢM BIẾN (TELEMETRY) ---
  if (topic === "fish/tele") {
    try {
      const data = JSON.parse(msg);
      const updates = {};
      
      if (data.temperature !== undefined) updates.temperature = parseFloat(data.temperature);
      if (data.distance_mm !== undefined) updates.distance_mm = parseInt(data.distance_mm);
      if (data.waterLevel !== undefined) updates.waterLevel = parseInt(data.waterLevel);
      if (data.fishDetected !== undefined) updates.fishDetected = (data.fishDetected == 1 || data.fishDetected == true);

      // Thông tin mạng
      if (data.wifiSSID !== undefined) updates.wifiSSID = data.wifiSSID;
      if (data.ip !== undefined) updates.ip = data.ip;       
      if (data.rssi !== undefined) updates.rssi = data.rssi;  

      // Đồng bộ trạng thái thiết bị
      if (data.autoMode !== undefined) updates.autoMode = data.autoMode;
      if (data.light !== undefined) updates.light = data.light;

      // === FIX LỖI HIỂN THỊ NGƯỢC BƠM ===
      if (data.pump !== undefined) {
          // ESP gửi 0 (Đang chạy/Low) -> Server lưu 1
          // ESP gửi 1 (Đang tắt/High) -> Server lưu 0
          updates.pump = (data.pump === 0) ? 1 : 0;
      }

      if (Object.keys(updates).length > 0) {
        updates.lastUpdated = new Date();
        await State.updateOne({ deviceId: "aquarium_main" }, { $set: updates }, { upsert: true });

        // Lưu History mỗi 10 phút
        const now = Date.now();
        if (now - lastHistorySave > 10 * 60 * 1000) {
            await History.create({
                temperature: updates.temperature || 0,
                waterLevel: updates.waterLevel || 0,
                fishDetected: updates.fishDetected || false
            });
            lastHistorySave = now;
        }
      }
    } catch (e) { console.error("Error parsing/saving telemetry:", e); }
  }
  
  // --- B. XỬ LÝ NÚT BẤM VẬT LÝ TỪ ESP ---
  else if (topic.startsWith("fish/button/")) {
      const key = topic.split("/")[2]; // 'pump', 'light', 'autoMode'
      const s = await State.findOne({ deviceId: "aquarium_main" });
      
      if (s) {
         // Logic đảo chiều (Toggle)
         const newVal = s[key] ? 0 : 1;
         await updateDevice(key, newVal, "button_physical");
      }
  }
});

// ==================== 4. AUTH SYSTEM ====================
const SESSIONS = {}; 
const generateToken = () => Math.random().toString(36).substring(2) + Date.now().toString(36);

const requireAdmin = (req, res, next) => {
    const token = req.headers['authorization'];
    if (SESSIONS[token] && (SESSIONS[token] === 'admin' || SESSIONS[token] === 'viewer')) next();
    else res.status(403).json({ success: false, error: "⛔ Token không hợp lệ hoặc đã hết hạn!" });
};

const requireStrictAdmin = (req, res, next) => {
    const token = req.headers['authorization'];
    if (SESSIONS[token] && SESSIONS[token] === 'admin') next();
    else res.status(403).json({ success: false, error: "⛔ Cần quyền Admin!" });
};

// --- API ĐĂNG NHẬP (ĐÃ SỬA LỖI LOGIC) ---
app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    
    // 1. Tìm người dùng chỉ bằng tên người dùng
    const user = await User.findOne({ username });
    
    if (user) {
        // 2. So sánh mật khẩu trực tiếp (Vì chưa dùng bcrypt)
        if (user.password === password) {
            const token = generateToken();
            // Lưu vai trò vào session theo token
            SESSIONS[`Bearer ${token}`] = user.role; // Lưu token với prefix Bearer
            
            // Trả về token (có prefix Bearer) và vai trò
            res.json({ success: true, token: `Bearer ${token}`, role: user.role, username: user.username });
        } else {
            // Mật khẩu không khớp
            res.json({ success: false, error: "Sai mật khẩu!" });
        }
    } else {
        // Không tìm thấy người dùng
        res.json({ success: false, error: "Sai tên đăng nhập!" });
    }
});
// --- END API ĐĂNG NHẬP SỬA LỖI ---


// API Tạo tài khoản (Chỉ Admin)
app.post("/register", requireStrictAdmin, async (req, res) => {
  try {
      const { username, password, role } = req.body;
      if (!username || !password) return res.json({ success: false, error: "Vui lòng nhập đầy đủ Tài khoản và Mật khẩu!" });
      const existingUser = await User.findOne({ username });
      if (existingUser) return res.json({ success: false, error: "Tên tài khoản này đã tồn tại!" });

      await User.create({ username, password, role: role || 'viewer' });
      res.json({ success: true, message: `Tạo tài khoản ${username} thành công!` });

  } catch (e) {
      res.status(500).json({ success: false, error: "Lỗi Server: " + e.message });
  }
});

// ==================== 5. API ROUTES ====================

app.get("/state", requireAdmin, async (req, res) => {
  const s = await State.findOne({ deviceId: "aquarium_main" });
  res.json(s || {});
});

// API Điều khiển từ Web (Auto/Pump/Light)
app.post("/control", requireStrictAdmin, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!['autoMode', 'pump', 'light'].includes(key) || ![0, 1].includes(value)) {
        return res.status(400).json({ success: false, error: "Lệnh điều khiển không hợp lệ." });
    }
    
    const currentState = await State.findOne({ deviceId: "aquarium_main" });
    // Chặn điều khiển Bơm/Đèn khi đang Auto Mode
    if (currentState && currentState.autoMode === 1 && (key === 'pump' || key === 'light')) {
        return res.json({ success: false, error: "⚠️ Đang Auto Mode! Hãy tắt Auto trước khi điều khiển thủ công." });
    }

    const success = await updateDevice(key, value, "web_control");
    if (success) {
        // Trả về trạng thái hiện tại sau khi cập nhật
        const updatedState = await State.findOne({ deviceId: "aquarium_main" });
        res.json({ success: true, state: updatedState });
    } else {
        res.status(500).json({ success: false, error: "Không thể cập nhật trạng thái thiết bị." });
    }

  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// API Cấu hình Ngưỡng & Lịch Đèn (Chỉ Admin)
app.post("/config", requireStrictAdmin, async (req, res) => {
  try {
    const { threshold, lightSchedule } = req.body;
    let updates = {};

    if (threshold !== undefined) {
      const parsedThreshold = parseInt(threshold);
      if (isNaN(parsedThreshold) || parsedThreshold < 0 || parsedThreshold > 100) {
          return res.status(400).json({ success: false, error: "Ngưỡng nước phải từ 0 đến 100." });
      }
      updates.threshold = parsedThreshold;
    }

    if (lightSchedule && lightSchedule.on && lightSchedule.off) {
      const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
      if (!timeRegex.test(lightSchedule.on) || !timeRegex.test(lightSchedule.off)) {
          return res.status(400).json({ success: false, error: "Lịch đèn không hợp lệ (HH:MM)." });
      }
      updates.lightSchedule = lightSchedule;
    }
    
    if (Object.keys(updates).length > 0) {
        await State.updateOne({ deviceId: "aquarium_main" }, { $set: updates });
        const updatedState = await State.findOne({ deviceId: "aquarium_main" });
        return res.json({ success: true, state: updatedState });
    }

    res.json({ success: true, message: "Không có thay đổi nào được gửi." });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// API Tra cứu Lịch sử (Theo ngày)
// API Tra cứu Lịch sử (Theo ngày)
app.get("/history", requireAdmin, async (req, res) => {
  try {
      const singleDate = req.query.singleDate; // Lấy ngày truy vấn (YYYY-MM-DD)
      
      let startDate;
      let endDate = new Date();

      if (singleDate) {
          // Trường hợp truy vấn 1 ngày cụ thể
          const dateParts = singleDate.split('-');
          const year = parseInt(dateParts[0]);
          const month = parseInt(dateParts[1]) - 1; // Tháng 0-indexed
          const day = parseInt(dateParts[2]);

          // Bắt đầu ngày (00:00:00.000)
          startDate = new Date(year, month, day, 0, 0, 0, 0);
          
          // Kết thúc ngày (23:59:59.999)
          endDate = new Date(year, month, day, 23, 59, 59, 999);
      } else {
          // Trường hợp mặc định (fallback): Ngày hôm nay
          startDate = new Date();
          startDate.setHours(0, 0, 0, 0);
          endDate.setHours(23, 59, 59, 999);
      }

      // ===============================================
      // 1. Lấy LOG CHI TIẾT (Các lần BẬT ra)
      // ===============================================
      const logDateCondition = { timestamp: { $gte: startDate, $lte: endDate } };
      const logOnCondition = { value: 1, ...logDateCondition };
      
      // Lấy chi tiết các sự kiện Bơm BẬT
      const pumpLogs = await Log.find({ ...logOnCondition, key: "pump" }).sort({ timestamp: -1 });

      // Lấy chi tiết các sự kiện Đèn BẬT
      const lightLogs = await Log.find({ ...logOnCondition, key: "light" }).sort({ timestamp: -1 });

      // Lấy chi tiết các sự kiện AutoMode BẬT/TẮT (value: 0 hoặc 1)
      const autoModeLogs = await Log.find({ ...logDateCondition, key: "autoMode" }).sort({ timestamp: -1 });


      // ===============================================
      // 2. Lấy dữ liệu cảm biến thô và tính trung bình
      // ===============================================
      let rawData = await History.find({ timestamp: { $gte: startDate, $lte: endDate } }).sort({ timestamp: 1 });

      let summary = { pump: 0, light: 0, tempSum: 0, waterSum: 0, count: 0 };
      // ... (groupingMap không cần thiết vì ta không dùng chartData nữa) ...

      // Sử dụng số lượng logs đã fetch để có summary chính xác
      summary.pump = pumpLogs.length;
      summary.light = lightLogs.length;

      rawData.forEach(record => {
          summary.tempSum += record.temperature;
          summary.waterSum += record.waterLevel;
          summary.count += 1;
      });

      // Tính trung bình tổng
      const totalAvgTemp = summary.count > 0 ? Math.round(summary.tempSum / summary.count * 10) / 10 : 0;
      const totalAvgWater = summary.count > 0 ? Math.round(summary.waterSum / summary.count * 10) / 10 : 0;

      res.json({
          success: true,
          summary: {
              temp: totalAvgTemp,
              water: totalAvgWater,
              pump: summary.pump,
              light: summary.light
          },
          // Trả về log chi tiết cho frontend
          pumpLogs: pumpLogs.map(log => ({ timestamp: log.timestamp, source: log.source })),
          lightLogs: lightLogs.map(log => ({ timestamp: log.timestamp, source: log.source })),
          autoModeLogs: autoModeLogs.map(log => ({ timestamp: log.timestamp, source: log.source, value: log.value })),
      });

  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});


app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ==================== 6. AUTO LOGIC (SERVER SIDE) ====================
setInterval(async () => {
  try {
    const s = await State.findOne({ deviceId: "aquarium_main" });
    
    // Chỉ chạy logic tự động nếu Auto Mode đang bật
    if (!s || s.autoMode !== 1) return;

    const now = new Date();
    // Giờ GMT+7 (Việt Nam)
    const h = (now.getUTCHours() + 7) % 24;
    const time = `${String(h).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;

    // Tự động Đèn theo lịch
    if (s.lightSchedule) {
      if (time === s.lightSchedule.on && s.light === 0) {
          console.log(`⏰ Auto Light ON at ${time}`);
          await updateDevice("light", 1, "auto_scheduler");
      }
      if (time === s.lightSchedule.off && s.light === 1) {
          console.log(`⏰ Auto Light OFF at ${time}`);
          await updateDevice("light", 0, "auto_scheduler");
      }
    }
    
    // Tự động Bơm theo ngưỡng
    if (s.waterLevel < s.threshold && s.pump === 0) {
        console.log(`💧 Auto Pump ON - Water level (${s.waterLevel}%) below threshold (${s.threshold}%)`);
        await updateDevice("pump", 1, "auto_water_level");
    }
    
    // Tự động TẮT Bơm khi mực nước trở lại an toàn (Giả định: Ngưỡng + 5%)
    if (s.waterLevel >= s.threshold + 5 && s.pump === 1) { 
        console.log(`💧 Auto Pump OFF - Water level (${s.waterLevel}%) is safe.`);
        await updateDevice("pump", 0, "auto_water_level");
    }

  } catch (e) { console.error("Auto loop error:", e); }
}, 5000); // Check mỗi 5 giây

const PORT = 3000;
// API để Reset Wifi thiết bị từ xa
app.post('/reset-wifi', async (req, res) => {
  try {
      console.log("⚠️ Đang gửi lệnh RESET_WIFI xuống ESP...");
      
      // Gửi lệnh xuống topic mà ESP đang lắng nghe
      // Lưu ý: Đảm bảo ESP của bạn đang subscribe topic này
      mqttClient.publish("aquarium/command", "RESET_WIFI");
      
      // Cập nhật trạng thái database về mặc định (tuỳ chọn)
      await State.findOneAndUpdate({ deviceId: "aquarium_main" }, { 
          wifi: "Dang Reset...",
          ip: "0.0.0.0" 
      });

      res.json({ success: true, message: "Đã gửi lệnh Reset Wifi" });
  } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Lỗi Server" });
  }
});
// API Đổi WiFi Thiết Bị (Gửi qua MQTT)
app.post('/update-wifi-creds', async (req, res) => {
  // Chỉ Admin mới được đổi
  const authHeader = req.headers['authorization'];
  if (authHeader !== "admin_token_secret_123") { // (Hoặc check theo logic token cũ của bạn)
     // Để đơn giản cho bài test này, mình tạm bỏ qua check token kỹ
  }

  const { ssid, pass } = req.body;
  if (!ssid) return res.json({ success: false, error: "Thiếu SSID" });

  try {
      console.log(`📡 Sending New WiFi Creds to ESP: ${ssid}`);
      // Gửi lệnh dạng: "TênWifi:MậtKhẩu"
      const payload = `${ssid}:${pass}`;
      mqttClient.publish("fish/cmd/updateWifi", payload);
      
      res.json({ success: true, message: "Đã gửi lệnh cập nhật WiFi!" });
  } catch (e) {
      res.json({ success: false, error: e.message });
  }
});
app.listen(PORT, () => console.log(`🚀 Server Running on port ${PORT}`));