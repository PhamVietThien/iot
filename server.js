const express = require("express");
const bodyParser = require("body-parser");
const mqtt = require("mqtt");
const path = require("path");
const mongoose = require("mongoose");

// --- 1. KẾT NỐI MONGODB ---
// Lấy link từ biến môi trường MONGO_URI trên Render
const mongoURI = process.env.MONGO_URI || "mongodb+srv://iot:FH29y9hfgRDpol2B@iot-cluster.hbgvh83.mongodb.net/?appName=iot-cluster";

mongoose.connect(mongoURI)
  .then(() => console.log("🍃 MongoDB Connected"))
  .catch(err => console.log("❌ MongoDB Error:", err));

// --- 2. ĐỊNH NGHĨA MODEL (Cấu trúc dữ liệu) ---

// Schema lưu trạng thái (Chỉ có 1 bản ghi duy nhất cho bể cá)
const StateSchema = new mongoose.Schema({
  deviceId: { type: String, default: "aquarium_main", unique: true }, 
  autoMode: { type: Number, default: 0 },
  pump: { type: Number, default: 0 },
  light: { type: Number, default: 0 },
  temperature: { type: Number, default: 0 },
  waterLevel: { type: Number, default: 0 }, // Tương ứng dist
  threshold: { type: Number, default: 20 },
  lightSchedule: {
    on: { type: String, default: "07:00" },
    off: { type: String, default: "18:00" }
  }
});
const State = mongoose.model("State", StateSchema);

// Schema lưu Nhật ký (Log)
const LogSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  type: { type: String, default: "info" },   // "info", "action", "error"
  message: String,
  details: Object
});
const Log = mongoose.model("Log", LogSchema);

// Khởi tạo trạng thái mặc định nếu chưa có
async function initDB() {
  const exist = await State.findOne({ deviceId: "aquarium_main" });
  if (!exist) {
    await State.create({ deviceId: "aquarium_main" });
    console.log("⚠️ Created default state");
  }
}
initDB();

// --- 3. MQTT CONFIG ---
const mqttClient = mqtt.connect("mqtts://6df16538873d4a909d0cfb6afbad9517.s1.eu.hivemq.cloud:8883", {
  username: "iot_nhom8",
  password: "Iot123456789",
  rejectUnauthorized: false,
  reconnectPeriod: 2000
});

mqttClient.on("connect", () => {
  console.log("⚡ MQTT connected");
  mqttClient.subscribe("fish/tele");
  mqttClient.subscribe("fish/button/#");
});

// --- 4. XỬ LÝ SERVER & API ---
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// API Lấy trạng thái
app.get("/state", async (req, res) => {
  const state = await State.findOne({ deviceId: "aquarium_main" });
  res.json(state || {});
});

// API Lấy Log (Lấy 50 dòng mới nhất)
app.get("/log", async (req, res) => {
  const logs = await Log.find().sort({ timestamp: -1 }).limit(50);
  res.json(logs);
});

// Hàm cập nhật thiết bị chung
async function updateDevice(key, value, source = "web") {
  // 1. Cập nhật DB
  const updateQuery = {};
  updateQuery[key] = value;
  await State.findOneAndUpdate({ deviceId: "aquarium_main" }, updateQuery);

  // 2. Gửi lệnh xuống ESP qua MQTT
  mqttClient.publish(`fish/cmd/${key}`, String(value));

  // 3. Ghi log
  await Log.create({ 
    type: "action", 
    message: `Set ${key} to ${value} (${source})` 
  });
}

// API Cập nhật từ Web
app.post("/update", async (req, res) => {
  const body = req.body;
  for (const key in body) {
    await updateDevice(key, body[key], "web");
  }
  res.json({ success: true });
});

// --- 5. XỬ LÝ DỮ LIỆU TỪ MQTT ---
mqttClient.on("message", async (topic, message) => {
  const msg = message.toString();
  try {
    if (topic === "fish/tele") {
      // Nhận dữ liệu cảm biến từ ESP
      const data = JSON.parse(msg);
      await State.findOneAndUpdate(
        { deviceId: "aquarium_main" },
        { 
          temperature: data.temp,
          waterLevel: data.dist, // Giả sử dist là mực nước
          pump: data.pump,
          light: data.light,
          autoMode: data.auto
        }
      );
    } else if (topic.startsWith("fish/button/")) {
      // Nút bấm vật lý
      await Log.create({ type: "info", message: `Physical button: ${topic}` });
    }
  } catch (e) { console.error(e); }
});

// --- 6. CHẾ ĐỘ TỰ ĐỘNG (AUTO MODE) ---
setInterval(async () => {
  try {
    const state = await State.findOne({ deviceId: "aquarium_main" });
    if (!state || !state.autoMode) return;

    // Giờ Việt Nam (UTC+7)
    const now = new Date();
    const h = (now.getUTCHours() + 7) % 24;
    const m = now.getUTCMinutes();
    const curTime = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;

    // Lịch đèn
    if (state.lightSchedule) {
      if (curTime === state.lightSchedule.on && state.light === 0) 
        await updateDevice("light", 1, "auto");
      if (curTime === state.lightSchedule.off && state.light === 1) 
        await updateDevice("light", 0, "auto");
    }

    // Bơm tự động (Ví dụ: nước thấp < threshold thì bơm)
    if (state.waterLevel < state.threshold && state.pump === 0) {
       await updateDevice("pump", 1, "auto-level");
    } else if (state.waterLevel >= state.threshold && state.pump === 1) {
       await updateDevice("pump", 0, "auto-level");
    }

  } catch (err) { console.error(err); }
}, 60000); // Quét mỗi 1 phút

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));