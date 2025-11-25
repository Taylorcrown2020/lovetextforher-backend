// -------------------------
// Load Environment Variables
// -------------------------
import dotenv from "dotenv";
dotenv.config();

// -------------------------
// Imports
// -------------------------
import express from "express";
import cors from "cors";
import pg from "pg";
import cron from "node-cron";
import { v4 as uuidv4 } from "uuid";

// -------------------------
// Express App
// -------------------------
const app = express();
app.use(cors());
app.use(express.json());

// -------------------------
// Root Route
// -------------------------
app.get("/", (req, res) => {
  res.send("LoveTextForHer Backend is Running ❤️");
});

// -------------------------
// PostgreSQL Database
// -------------------------
const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

// -------------------------
// Unsubscribe Route
// -------------------------
app.post("/api/unsubscribe/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const result = await pool.query(
      "UPDATE users SET is_active = false WHERE unsubscribe_token = $1 RETURNING email",
      [token]
    );

    if (result.rowCount === 0) {
      return res.json({ success: false, error: "Invalid unsubscribe token." });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Unsubscribe Error:", error);
    res.json({ success: false, error: "Server error." });
  }
});

// -------------------------
// Cron Job (Runs every minute)
// -------------------------
cron.schedule("* * * * *", async () => {
  console.log("⏱ Cron Triggered:", new Date().toISOString());

  try {
    const dueUsers = await pool.query(
      "SELECT * FROM users WHERE is_active = true AND next_delivery <= NOW()"
    );

    for (const user of dueUsers.rows) {
      console.log("Sending message to:", user.email);

      // 👇 This is where your email send code will go
      // sendEmail(user.email, user.name);

      // Update next delivery
      await pool.query(
        "UPDATE users SET last_sent = NOW(), next_delivery = NOW() + INTERVAL '1 day' WHERE id = $1",
        [user.id]
      );
    }
  } catch (err) {
    console.error("Cron Error:", err);
  }
});

// -------------------------
// Start Server
// -------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
