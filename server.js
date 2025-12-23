const express = require("express");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const mqtt = require("mqtt");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const path = require("path");

const app = express();
app.use(bodyParser.json());

const SECRET_KEY = "NAGUMO_SECRET_KEY_2025"; 
const MONGO_URI = "mongodb+srv://nagumo:P123456789@cluster0.x4jnpxy.mongodb.net/fish?retryWrites=true&w=majority";

let monitor = { 
    lastTeleTime: Date.now(), 
    alerts: [],
    pumpStartTime: null,
    lastDistance: 0,
    fishDetected: 0 // THÊM: Trạng thái cá hiện tại
};

let isProcessingAutoOff = false; 
let lastUpdateTimes = { pump: 0, light: 0, autoMode: 0 }; 

const SAFETY_CONFIG = {
    MAX_PUMP_TIME_MS: 10 * 60,
    MAX_TEMP: 35, MIN_TEMP: 20,
    LEAK_THRESHOLD_MM: 30,
    RELAY_STICKY_THRESHOLD_MM: 15
};

mongoose.connect(MONGO_URI).then(async () => {
    console.log(" Kết nối MongoDB thành công!");
    const adminExists = await User.findOne({ role: "admin" });
    if (!adminExists) {
        const hashed = await bcrypt.hash("123", 10);
        await User.create({ username: "admin", password: hashed, role: "admin" });
    }
    runAutoLogic(); 
    cleanOldLogs(); 
}).catch(err => console.error(" Lỗi kết nối DB:", err));

const User = mongoose.model("User", new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    role: { type: String, enum: ["admin", "user"], default: "user" }
}));

const State = mongoose.model("State", new mongoose.Schema({
    autoMode: { type: Number, default: 0 },
    pump: { type: Number, default: 0 },
    light: { type: Number, default: 0 },
    temperature: { type: Number, default: 0 },
    distance_mm: { type: Number, default: 0 },
    fish: { type: Number, default: 0 }, // THÊM: Lưu trạng thái cá vào DB
    threshold: { type: Number, default: 150 },
    lightSchedule: { on: String, off: String }
}));

const Log = mongoose.model("Log", new mongoose.Schema({
    timestamp: { type: Date, default: Date.now }, 
    action: String, 
    source: String,
    dateStr: String 
}));

const mqttClient = mqtt.connect("mqtts://53b5dabe36884227a54ddeb2601c76fb.s1.eu.hivemq.cloud:8883", {
    username: "nagumo", password: "Ph123456789", rejectUnauthorized: false
});

mqttClient.on("connect", () => {
    mqttClient.subscribe(["fish/tele", "fish/event/button", "fish/event/motion"]);
    console.log(" MQTT Connected");
});

mqttClient.on("message", async (topic, msg) => {
    const payload = msg.toString();
    try {
        const data = JSON.parse(payload);
        
        if (topic === "fish/tele") {
            const state = await State.findOne();
            if (!state) return;

            monitor.fishDetected = data.fish || 0;

            const hasTempChanged = Math.abs(state.temperature - data.temperature) > 0.5;
            const hasDistChanged = Math.abs(state.distance_mm - data.distance_mm) > 2;
            const hasFishChanged = state.fish !== data.fish; // THÊM: Kiểm tra cá thay đổi

            if (hasTempChanged || hasDistChanged || hasFishChanged) {
                await State.updateOne({}, { 
                    temperature: data.temperature, 
                    distance_mm: data.distance_mm,
                    fish: data.fish || 0 // Cập nhật cá vào DB
                });
            }

            if (state.pump === 0) {
                if ((data.distance_mm - monitor.lastDistance) > SAFETY_CONFIG.LEAK_THRESHOLD_MM) addAlert("🚨 Phát hiện rò rỉ!");
                if ((monitor.lastDistance - data.distance_mm) > SAFETY_CONFIG.RELAY_STICKY_THRESHOLD_MM) addAlert("⚠️ Lỗi Relay Bơm!");
            }
            if (data.temperature > SAFETY_CONFIG.MAX_TEMP || data.temperature < SAFETY_CONFIG.MIN_TEMP) 
                addAlert(` Nhiệt độ bất thường: ${data.temperature}°C`);

            if (data.fish === 1) addAlert(" Phát hiện cá đang hoạt động!");

            monitor.lastTeleTime = Date.now();
            monitor.lastDistance = data.distance_mm;
        } 
        
        if (topic === "fish/event/button") {
            const state = await State.findOne();
            if (state) await updateDevice(data.key, state[data.key] === 1 ? 0 : 1, "Nút vật lý");
        }

        // Nhận event riêng lẻ (nếu có)
        if (topic === "fish/event/motion") {
            addAlert(" Mặt nước động - Có cá bơi ngang!");
        }

    } catch (e) {
        console.error("Lỗi xử lý MQTT message:", e.message);
    }
});

function addAlert(msg) {
    if (monitor.alerts[0] !== msg) { 
        monitor.alerts.unshift(msg); 
        if (monitor.alerts.length > 2) monitor.alerts.pop(); 
        console.log(`[ALERT] ${msg}`); 
    }
}

async function updateDevice(key, value, source) {
    if (isProcessingAutoOff && source === "Hệ thống tự động") return false;
    let state = await State.findOne() || await State.create({});
    
    if (state[key] === value) return false; 
    if (Date.now() - lastUpdateTimes[key] < 1200) return false;
    if (state.autoMode === 1 && (key === 'pump' || key === 'light') && source !== "Hệ thống tự động") return false;

    lastUpdateTimes[key] = Date.now();
    state[key] = value;
    await state.save();
    
    sendMqttCmd(key, value);
    
    const vnDate = new Date(Date.now() + 7 * 3600000).toISOString().split('T')[0];
    await Log.create({ 
        action: `${key === "pump" ? "Máy bơm" : (key === "light" ? "Đèn LED" : "Auto")}: ${value === 1 ? "BẬT" : "TẮT"}`, 
        source: source,
        dateStr: vnDate
    });

    if (key === "autoMode" && value === 0) {
        isProcessingAutoOff = true;
        await State.updateOne({}, { pump: 0, light: 0 });
        sendMqttCmd("pump", 0); sendMqttCmd("light", 0);
        setTimeout(() => { isProcessingAutoOff = false; }, 3000);
    }
    return true;
}

function sendMqttCmd(key, value) {
    let val = (key === 'pump') ? (value === 1 ? 0 : 1) : value;
    mqttClient.publish(`fish/cmd/${key}`, String(val), { qos: 1 });
}

async function cleanOldLogs() {
    try {
        const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
        await Log.deleteMany({ timestamp: { $lt: fiveDaysAgo } });
        const stats = await mongoose.connection.db.command({ dbStats: 1 });
        const dataSizeMB = stats.dataSize / (1024 * 1024);
        if (dataSizeMB > 500) {
            const oldestLogs = await Log.find().sort({ timestamp: 1 }).limit(1000);
            await Log.deleteMany({ _id: { $in: oldestLogs.map(log => log._id) } });
        }
    } catch (err) { console.error("Lỗi dọn dẹp Log:", err.message); }
    setTimeout(cleanOldLogs, 12 * 60 * 60 * 1000);
}

async function runAutoLogic() {
    try {
        const state = await State.findOne();
        if (state && Date.now() - monitor.lastTeleTime > 60000) addAlert(" ESP8266 Offline!");
        else if (monitor.alerts[0] === " ESP8266 Offline!") monitor.alerts.shift();

        if (state && state.autoMode === 1 && !isProcessingAutoOff) {
            const now = new Date(Date.now() + 7*3600000).toISOString().substr(11, 5);
            if (state.lightSchedule?.on && state.lightSchedule?.off) {
                let targetL = (now >= state.lightSchedule.on && now < state.lightSchedule.off) ? 1 : 0;
                if (state.light !== targetL) await updateDevice("light", targetL, "Hệ thống tự động");
            }
            let targetP = state.pump;
            if (state.distance_mm < state.threshold + 20) targetP = 1;
            else if (state.distance_mm > state.threshold - 20) targetP = 0;
            if (state.pump !== targetP) await updateDevice("pump", targetP, "Hệ thống tự động");
        }
    } catch (err) {}
    setTimeout(runAutoLogic, 3000);
}

const auth = (req, res, next) => {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "No Token" });
    try { req.user = jwt.verify(token, SECRET_KEY); next(); } 
    catch (e) { res.status(401).json({ error: "Invalid Token" }); }
};

app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (user && await bcrypt.compare(password, user.password)) {
        const token = jwt.sign({ username: user.username, role: user.role }, SECRET_KEY);
        res.json({ token, role: user.role, username: user.username });
    } else res.status(401).send();
});
app.post("/api/register", auth, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).send();
    const hashed = await bcrypt.hash(req.body.password, 10);
    await User.create({ username: req.body.username, password: hashed, role: 'user' });
    res.json({ success: true });
});
app.get("/state", auth, async (req, res) => {
    const s = await State.findOne() || {};
    res.json({ ...s.toObject(), alerts: monitor.alerts });
});

app.post("/update", auth, async (req, res) => {
    const key = Object.keys(req.body)[0];
    await updateDevice(key, req.body[key], req.user.username);
    res.json({ success: true });
});

app.post("/config", auth, async (req, res) => {
    await State.updateOne({}, req.body, { upsert: true });
    res.json({ success: true });
});

app.get("/api/logs", auth, async (req, res) => {
    const query = req.query.date ? { dateStr: req.query.date } : {};
    const logs = await Log.find(query).sort({ timestamp: -1 }).limit(30);
    res.json(logs);
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(3000, () => console.log("🚀 Server Ready on port 3000"));