const admin = require("firebase-admin");
const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const mqtt = require("mqtt");
const path = require("path");

const serviceAccount = require("./firebase-key.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://pump-88184-default-rtdb.firebaseio.com/"
});
const db = admin.database();
console.log("🔥 Firebase connected");

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

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
mqttClient.on("error", console.log);
mqttClient.on("reconnect", () => console.log("🔄 MQTT reconnecting"));

// --------- Helper: update device state + count + log ---------
async function updateDevice(key, newState, source="esp") {
  const snap = await db.ref("device/state").once("value");
  const state = snap.exists() ? snap.val() : {};

  // OFF -> ON count
  if ((key === "light" || key === "pump") && !state[key] && newState) {
    const countKey = key + "Count";
    const currentCount = state[countKey] || 0;
    await db.ref(`device/state/${countKey}`).set(currentCount + 1);
  }

  // Cập nhật state nếu thay đổi
  if (state[key] !== newState) {
    await db.ref(`device/state/${key}`).set(newState);
    mqttClient.publish(`fish/cmd/${key}`, String(newState));

    // Ghi log mỗi action 1 dòng
    await db.ref("device/log").push({
      where: source,
      key: key,
      value: newState,
      time: Date.now()
    });

    console.log(`🔄 [${source}] ${key} updated: ${newState}`);
  }
}

// --------- MQTT Handler ---------
mqttClient.on("message", async (topic,msg)=>{
  const text = msg.toString();

  // ESP gửi Telemetry
  if(topic==="fish/tele"){
    try{
      const data = JSON.parse(text);
      const snap = await db.ref("device/state").once("value");
      const state = snap.exists()?snap.val():{};

      // Light
      if(data.light!==undefined && data.light!==state.light) await updateDevice("light",data.light,"esp");
      // Pump
      if(data.pump!==undefined && data.pump!==state.pump) await updateDevice("pump",data.pump,"esp");

      // Các key khác
      const keys = ["temperature","distance_mm","threshold"];
      const updates = {};
      keys.forEach(k=>{if(data[k]!==undefined) updates[k]=data[k];});

      // WaterLevel từ distance_mm (không %)
      if(updates.distance_mm!==undefined){
        const maxDistance = 200; // mm cho cạn
        updates.waterLevel = Math.max(0, Math.min(maxDistance, updates.distance_mm));
      }

      updates.lastUpdate = Date.now();
      await db.ref("device/state").update(updates);

    }catch(err){console.log(err);}
    return;
  }

  // ESP bấm nút
  if(topic.startsWith("fish/button/")){
    const key = topic.split("/")[2];
    if(!key) return;
    try{
      const snap = await db.ref("device/state").once("value");
      const state = snap.exists()?snap.val():{};
      const next = state[key]?0:1;
      await updateDevice(key,next,"esp");
    }catch(err){console.log(err);}
  }
});

// --------- REST API ---------
app.post("/update", async (req,res)=>{
  try{
    const updates = req.body;

    for(const key of Object.keys(updates)){
      if(key==="light" || key==="pump") await updateDevice(key,updates[key],"ui");
      else if(key==="autoMode"){
        await db.ref("device/state/autoMode").set(updates[key]);
        mqttClient.publish("fish/cmd/autoMode",String(updates[key]));
        await db.ref("device/log").push({where:"ui", key:"autoMode", value:updates[key], time:Date.now()});
      } else {
        await db.ref(`device/state/${key}`).set(updates[key]);
        mqttClient.publish(`fish/cmd/${key}`,String(updates[key]));
        await db.ref("device/log").push({where:"ui", key:key, value:updates[key], time:Date.now()});
      }
    }

    res.json({success:true});
  }catch(err){res.status(500).json({success:false,error:String(err)})}
});

app.get("/state", async (req,res)=>{
  try{
    const snap = await db.ref("device/state").once("value");
    res.json(snap.exists()?snap.val():{
      autoMode:0,pump:0,light:0,temperature:0,distance_mm:0,threshold:50,lightCount:0,pumpCount:0,waterLevel:0
    });
  }catch(err){res.status(500).json({error:String(err)})}
});

app.get("/log", async (req,res)=>{
  try{
    const snap = await db.ref("device/log").once("value");
    res.json(snap.exists()?snap.val():{});
  }catch(err){res.status(500).json({error:String(err)})}
});

// --------- Auto Mode: Light Schedule + Pump Threshold ---------
setInterval(async ()=>{
  try{
    const snap = await db.ref("device/state").once("value");
    const state = snap.exists()?snap.val():{};
    if(!state.autoMode) return;

    const hhmm = new Date().toTimeString().slice(0,5);

    // Light schedule
    if(state.lightSchedule){
      let light = state.light;
      if(hhmm===state.lightSchedule.on) light=1;
      if(hhmm===state.lightSchedule.off) light=0;
      if(light!==state.light) await updateDevice("light",light,"server");
    }

    // Pump auto if waterLevel < threshold
    if(state.waterLevel !== undefined && state.threshold !== undefined){
      const pump = state.waterLevel < state.threshold ? 1 : 0;
      if(pump!==state.pump) await updateDevice("pump",pump,"server");
    }

  }catch(err){console.log(err);}
},60000);

// --------- Start Server ---------
const PORT = process.env.PORT || 10000;

// Nếu bạn để index.html bên cạnh server.js:
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Render bắt buộc phải dùng http.createServer
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
