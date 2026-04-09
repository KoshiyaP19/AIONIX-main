require("dotenv").config();
const axios = require("axios");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const clusterLogs = require("./utils/clusterLogs");

const serviceState = require("./utils/serviceState");

const RLAgent = require("./rlAgent");


const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// ================= DATABASE CONNECTION =================

mongoose.connect( "mongodb+srv://aionixUser:w%26DXUPwGum1%24@cluster0.dfdfhfi.mongodb.net/aionix?retryWrites=true&w=majority" ) .then(() => console.log("✅ MongoDB Atlas Connected")) .catch((err) => console.error("❌ MongoDB Connection Error:", err));

// ================= SCHEMAS =================

const LogSchema = new mongoose.Schema({
  service: String,
  message: String,
  severity: String,
  anomaly: Boolean,
  timestamp: { type: Date, default: Date.now }
});

const HealingSchema = new mongoose.Schema({
  service: String,
  action: String,
  status: String,
  timestamp: { type: Date, default: Date.now }
});

const QTableSchema = new mongoose.Schema({
  state: String,
  actions: Object
});

// ================= MODELS =================

const Log = mongoose.model("Log", LogSchema);
const Healing = mongoose.model("Healing", HealingSchema);
const QTable = mongoose.model("QTable", QTableSchema);

// ================= RL AGENT =================

const rlAgent = new RLAgent(QTable);

// ================= LOGIC =================

function decideHealingAction(log) {
  if (!log.anomaly) return null;
  return rlAgent.chooseAction(log);
}

// ================= POST LOG =================

app.post("/api/logs", async (req, res) => {
  try {
    let { service, message, severity, anomaly } = req.body;

    console.log("📡 INCOMING LOG:", service, severity);

    // ✅ Normalize (VERY IMPORTANT FIX)
    service = service || "unknown-service";
    severity = (severity || "INFO").toUpperCase();
    anomaly = anomaly || false;

    const log = await Log.create({
      service,
      message,
      severity,
      anomaly
    });

    // 🔥 REAL-TIME EMIT
    io.emit("newLog", log);

    console.log("📤 SENT TO DASHBOARD");

    // ================= RL =================
    const action = decideHealingAction(log);

    if (action) {
      console.log("🤖 AI Decision:", action);

      const healingEvent = await Healing.create({
        service: log.service,
        action,
        status: "EXECUTED"
      });

      io.emit("healingEvent", healingEvent);
    }

    res.status(201).json({ success: true, log });

  } catch (error) {
    console.error("❌ Log ingestion error:", error);
    res.status(500).json({ error: "Failed to ingest log" });
  }
});

// ================= SYSTEM STATS ENDPOINT =================

app.get("/stats", async (req, res) => {

  try {

    const logs = await Log.find();
     const totalLogs = await Log.countDocuments();

    // const totalLogs = logs.length;

    const anomalies = logs.filter(
      (log) =>
        log.anomaly === true ||
        (log.severity && log.severity.toUpperCase() === "HIGH")
    ).length;

    const services = new Set(
      logs.map((log) => log.service || "unknown-service")
    ).size;

    res.json({
      totalLogs,
      anomalies,
      services
    });

  } catch (error) {

    console.error("Stats fetch error:", error);

    res.status(500).json({
      error: "Failed to fetch stats"
    });

  }

});

// ================= GET CLEAN Q-TABLE =================

app.get("/qtable", async (req, res) => {

  try {

    const entries = await QTable.find().lean();

    const formatted = entries.map(entry => ({
      state: entry.state,
      actions: entry.actions
    }));

    res.json(formatted);

  } catch (error) {

    console.error(error);

    res.status(500).json({ error: "Failed to fetch Q-table" });

  }

});

// ================= GET ALL LOGS =================

app.get("/logs", async (req, res) => {

  try {

    const logs = await Log.find()
      .sort({ timestamp: -1 })
      .limit(100);

    res.json(logs);

  } catch (error) {

    console.error(error);

    res.status(500).json({ error: "Failed to fetch logs" });

  }

});


app.get("/services", (req, res) => {

  const states = serviceState.getStates();

  res.json(states);

});

// ================= ROOT CAUSE CLUSTERS =================

app.get("/clusters", async (req, res) => {

  try {

    const logs = await Log.find()
      .sort({ timestamp: -1 })
      .limit(200);

    const clusters = clusterLogs(logs);

    res.json(clusters);

  } catch (err) {

    console.error("Cluster error:", err);

    res.status(500).json({
      error: "Failed to generate clusters"
    });

  }

});

// ================= GET HEALING EVENTS =================

app.get("/healing", async (req, res) => {

  try {

    const events = await Healing.find()
      .sort({ timestamp: -1 })
      .limit(100);

    res.json(events);

  } catch (error) {

    console.error("Healing fetch error:", error);

    res.status(500).json({
      error: "Failed to fetch healing events"
    });

  }

});

// ================= SERVER START =================

const PORT = process.env.PORT || 5000;

server.listen(PORT, async () => {
  await rlAgent.loadQTable();
  console.log(`🚀 Server running on port ${PORT}`);
});

setInterval(() => {
  const log = {
    service: "render-instance",
    message: "Auto log from cloud instance",
    severity: Math.random() > 0.7 ? "HIGH" : "LOW",
    anomaly: Math.random() > 0.7
  };

  require("axios").post(
    "https://aionix-main.onrender.com/api/logs",
    log
  );

  console.log("☁️ Cloud log sent");
}, 5000);