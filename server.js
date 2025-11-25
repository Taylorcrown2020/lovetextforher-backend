process.env.TZ = "UTC";

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public")); // index.html, admin.html, unsubscribe.html

// ===============================
// Serve Admin Dashboard
// ===============================
app.get("/admin", (req, res) => {
    res.sendFile(__dirname + "/public/admin.html");
});

// ===============================
// DATABASE CONNECTION
// ===============================
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false }
});

pool.query("SELECT NOW()")
    .then(() => console.log("✅ Database connected"))
    .catch(err => console.error("❌ Database error:", err));

// ===============================
// SMTP CONFIG (BREVO SMTP RELAY)
// ===============================
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

transporter.verify(err => {
    if (err) console.error("❌ SMTP Error:", err);
    else console.log("📧 SMTP Ready");
});

// ===============================
// SEND EMAIL
// ===============================
async function sendEmail(recipient, subject, message, token) {
    try {
        const unsubscribeURL = `${process.env.BASE_URL}/unsubscribe.html?token=${token}`;

        const body = `${message}\n\nTo unsubscribe, click here:\n${unsubscribeURL}`;

        await transporter.sendMail({
            from: process.env.FROM_EMAIL,
            to: recipient,
            subject,
            text: body
        });

        console.log(`📤 Sent to ${recipient}`);
    } catch (err) {
        console.error("❌ Email send error:", err);
    }
}

// ===============================
// HELPERS
// ===============================
function generateToken() {
    return crypto.randomBytes(32).toString("hex");
}

const MESSAGES = [
    "❤️ Good morning! Just a reminder that you're loved more than you know.",
    "💘 Thinking about you and how lucky I am to have you.",
    "💕 You make my world brighter.",
    "💖 You are my favorite notification.",
    "😘 Just a small reminder that you're amazing."
];

function randomMessage(name) {
    const base = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
    return name ? `${name}, ${base}` : base;
}

function calculateNextDelivery(freq, timings) {
    const map = { morning: 8, afternoon: 13, evening: 19, night: 22 };

    const next = new Date();
    next.setHours(map[timings[0]] || 8, 0, 0, 0);

    if (next <= new Date()) {
        const inc = {
            daily: 1,
            "every-other-day": 2,
            "three-times-week": 2,
            weekly: 7,
            "bi-weekly": 14
        };
        next.setDate(next.getDate() + (inc[freq] || 1));
    }

    return next;
}

// ===============================
// SIGNUP
// ===============================
app.post("/api/signup", async (req, res) => {
    try {
        const { email, name, frequency, timings, timezone } = req.body;

        if (!email || !frequency || !timings || !timezone)
            return res.status(400).json({ success: false, error: "Missing fields" });

        const token = generateToken();
        const next = calculateNextDelivery(frequency, timings);

        const exists = await pool.query("SELECT * FROM users WHERE email=$1", [email]);

        if (exists.rows.length > 0) {
            await pool.query(
                `UPDATE users 
                 SET name=$1, frequency=$2, timings=$3, timezone=$4,
                     next_delivery=$5, unsubscribe_token=$6, is_active=true
                 WHERE email=$7`,
                [name, frequency, timings, timezone, next, token, email]
            );
        } else {
            await pool.query(
                `INSERT INTO users (email, name, frequency, timings, timezone, next_delivery, unsubscribe_token)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [email, name, frequency, timings, timezone, next, token]
            );
        }

        return res.json({ success: true });
    } catch (err) {
        console.error("Signup error:", err);
        res.status(500).json({ success: false });
    }
});

// ===============================
// UNSUBSCRIBE
// ===============================
app.post("/api/unsubscribe/:token", async (req, res) => {
    const { token } = req.params;

    const result = await pool.query(
        "UPDATE users SET is_active=false WHERE unsubscribe_token=$1 RETURNING *",
        [token]
    );

    if (result.rowCount === 0)
        return res.status(400).json({ success: false, error: "Invalid token" });

    res.json({ success: true });
});

// ===============================
// ADMIN ENDPOINTS
// ===============================
app.get("/api/admin/users", async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM users ORDER BY id DESC");
    res.json(rows);
});

app.post("/api/admin/send/:id", async (req, res) => {
    await pool.query(
        "UPDATE users SET next_delivery = NOW() - INTERVAL '1 minute' WHERE id=$1",
        [req.params.id]
    );
    res.json({ success: true });
});

app.post("/api/admin/active/:id", async (req, res) => {
    await pool.query(
        "UPDATE users SET is_active=$1 WHERE id=$2",
        [req.body.is_active, req.params.id]
    );
    res.json({ success: true });
});

app.delete("/api/admin/delete/:id", async (req, res) => {
    await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);
    res.json({ success: true });
});

// ===============================
// CRON JOB — SEND MESSAGES
// Runs every minute
// ===============================
console.log("🔥 Cron system initialized...");

cron.schedule("* * * * *", async () => {
    console.log("⏱ Cron triggered:", new Date().toISOString());

    try {
        const { rows: users } = await pool.query(
            `SELECT * FROM users 
             WHERE is_active=true 
               AND next_delivery <= NOW()`
        );

        console.log(`📬 ${users.length} users due`);

        for (const user of users) {
            console.log("➡ Sending to:", user.email);

            const msg = randomMessage(user.name);

            await sendEmail(
                user.email,
                "Your Daily Love Message ❤️",
                msg,
                user.unsubscribe_token
            );

            const next = calculateNextDelivery(user.frequency, user.timings);

            await pool.query(
                "UPDATE users SET next_delivery=$1, last_sent=NOW() WHERE id=$2",
                [next, user.id]
            );

            console.log(`🔁 Rescheduled ${user.email} → ${next}`);
        }
    } catch (err) {
        console.error("Cron error:", err);
    }
});

// ===============================
// SERVER START
// ===============================
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});