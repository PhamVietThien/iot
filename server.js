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
    lastDistance: 0
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
    threshold: { type: Number, default: 150 },
    lightSchedule: { on: String, off: String }
}));

const Log = mongoose.model("Log", new mongoose.Schema({
    timestamp: { type: Date, default: Date.now }, 
    action: String, 
    source: String,
    dateStr: String // Dùng để thống kê theo ngày (YYYY-MM-DD)
}));

const mqttClient = mqtt.connect("mqtts://53b5dabe36884227a54ddeb2601c76fb.s1.eu.hivemq.cloud:8883", {
    username: "nagumo", password: "Ph123456789", rejectUnauthorized: false
});

mqttClient.on("connect", () => {
    mqttClient.subscribe(["fish/tele", "fish/event/button"]);
    console.log("📡 MQTT Connected");
});

mqttClient.on("message", async (topic, msg) => {
    const payload = msg.toString();
    try {
        const data = JSON.parse(payload);
        if (topic === "fish/tele") {
           

            const state = await State.findOne();
            if (!state) return;

            // Chỉ cập nhật nếu Nhiệt độ lệch > 0.5 độ HOẶC Khoảng cách lệch > 2mm
            const hasTempChanged = Math.abs(state.temperature - data.temperature) > 0.5;
            const hasDistChanged = Math.abs(state.distance_mm - data.distance_mm) > 2;

            if (hasTempChanged || hasDistChanged) {
                await State.updateOne({}, { 
                    temperature: data.temperature, 
                    distance_mm: data.distance_mm 
                });
            }
            console.log(" Đã cập nhật dữ liệu cảm biến mới vào DB");

            if (state.pump === 0) {
                if ((data.distance_mm - monitor.lastDistance) > SAFETY_CONFIG.LEAK_THRESHOLD_MM) addAlert("🚨 Phát hiện rò rỉ!");
                if ((monitor.lastDistance - data.distance_mm) > SAFETY_CONFIG.RELAY_STICKY_THRESHOLD_MM) addAlert("⚠️ Lỗi Relay Bơm!");
            }
            if (data.temperature > SAFETY_CONFIG.MAX_TEMP || data.temperature < SAFETY_CONFIG.MIN_TEMP) 
                addAlert(` Nhiệt độ bất thường: ${data.temperature}°C`);

            monitor.lastTeleTime = Date.now();
            monitor.lastDistance = data.distance_mm;
        } 
        if (topic === "fish/event/button") {
            const state = await State.findOne();
            if (state) await updateDevice(data.key, state[data.key] === 1 ? 0 : 1, "Nút vật lý");
        }
    } catch (e) {
        console.error(" Lỗi xử lý MQTT message:", e.message);
    }
});

function addAlert(msg) {
    if (monitor.alerts[0] !== msg) { monitor.alerts = [msg]; console.log(`[ALERT] ${msg}`); }
}

async function updateDevice(key, value, source) {
    if (isProcessingAutoOff && source === "Hệ thống tự động") return false;
    let state = await State.findOne() || await State.create({});
    if (state[key] === value) {
        // Nếu trạng thái không đổi, thoát luôn, không ghi DB, không gửi MQTT
        return false; 
    }
    if (Date.now() - lastUpdateTimes[key] < 1200) return false;
    if (state.autoMode === 1 && (key === 'pump' || key === 'light') && source !== "Hệ thống tự động") return false;

    if (state[key] !== value) {
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
    }
    return true;
}

function sendMqttCmd(key, value) {
    let val = (key === 'pump') ? (value === 1 ? 0 : 1) : value;
    mqttClient.publish(`fish/cmd/${key}`, String(val), { qos: 1 });
}

// Hàm tự động dọn dẹp Log theo thời gian và dung lượng
async function cleanOldLogs() {
    try {
        console.log(" Đang kiểm tra để dọn dẹp Database...");
        
        
        const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
        const timeResult = await Log.deleteMany({ timestamp: { $lt: fiveDaysAgo } });
        if (timeResult.deletedCount > 0) {
            console.log(`- Đã xóa ${timeResult.deletedCount} bản ghi cũ hơn 5 ngày.`);
        }

        const stats = await mongoose.connection.db.command({ dbStats: 1 });
        const dataSizeMB = stats.dataSize / (1024 * 1024); // Đổi sang MB
        
        console.log(`- Dung lượng hiện tại: ${dataSizeMB.toFixed(2)} MB`);

        if (dataSizeMB > 500) {
            console.log(" Dung lượng vượt ngưỡng 500MB! Đang xóa bớt dữ liệu cũ...");
            const oldestLogs = await Log.find().sort({ timestamp: 1 }).limit(1000);
            const idsToDelete = oldestLogs.map(log => log._id);
            await Log.deleteMany({ _id: { $in: idsToDelete } });
            console.log("- Đã xóa 1000 bản ghi cũ nhất để giảm dung lượng.");
        }

    } catch (err) {
        console.error(" Lỗi khi dọn dẹp Log:", err.message);
    }
    setTimeout(cleanOldLogs, 12 * 60 * 60 * 1000);
}

async function runAutoLogic() {
    try {
        const state = await State.findOne();
        if (state && Date.now() - monitor.lastTeleTime > 60000) addAlert(" ESP8266 Offline!");
        else if (monitor.alerts[0] === " ESP8266 Offline!") monitor.alerts = [];

        if (state && state.autoMode === 1 && !isProcessingAutoOff) {
            const now = new Date(Date.now() + 7*3600000).toISOString().substr(11, 5);
            if (state.lightSchedule?.on && state.lightSchedule?.off) {
                let targetL = (now >= state.lightSchedule.on && now < state.lightSchedule.off) ? 1 : 0;
                if (state.light !== targetL) await updateDevice("light", targetL, "Hệ thống tự động");
            }
            let targetP = state.pump;
            if (state.distance_mm < state.threshold + 20) {
            targetP = 1; // Nước thấp hơn ngưỡng -> Bật bơm
            } else if (state.distance_mm > state.threshold - 20) {
                targetP = 0; // Nước cao hơn ngưỡng -> Tắt bơm
            }
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

app.get("/api/stats", auth, async (req, res) => {
    const date = req.query.date;
    if (date) {
        const pump = await Log.countDocuments({ dateStr: date, action: /Máy bơm: BẬT/ });
        const light = await Log.countDocuments({ dateStr: date, action: /Đèn LED: BẬT/ });
        return res.json({ filter: true, date, pump, light });
    }
    const stats = await Log.aggregate([
        { $match: { action: /BẬT/ } },
        { $group: { 
            _id: "$dateStr", 
            pump: { $sum: { $cond: [{ $regexMatch: { input: "$action", regex: /Máy bơm/ } }, 1, 0] } },
            light: { $sum: { $cond: [{ $regexMatch: { input: "$action", regex: /Đèn LED/ } }, 1, 0] } }
        }},
        { $sort: { _id: -1 } },
        { $limit: 7 }
    ]);
    res.json({ stats });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(3000, () => console.log("🚀 Server Ready"));