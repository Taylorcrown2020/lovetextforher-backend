/***************************************************************
 *  LoveTextForHer — Backend (Part 1 / 7)
 *  ------------------------------------------------------------
 *  ✔ Stripe FIRST
 *  ✔ Webhook BEFORE JSON parser
 *  ✔ DB connected
 *  ✔ Helpers ready
 ***************************************************************/

process.env.TZ = "UTC";
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const path = require("path");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const { Resend } = require("resend");

const app = express();
const PORT = process.env.PORT || 3000;

/***************************************************************
 *  STRIPE — MUST LOAD FIRST
 ***************************************************************/
let stripe = null;

if (process.env.STRIPE_SECRET_KEY) {
    stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    console.log("⚡ Stripe Loaded");
} else {
    console.error("❌ Missing STRIPE_SECRET_KEY");
}

/***************************************************************
 *  PRICE MAP (Your exact IDs)
 ***************************************************************/
const PRICE_MAP = {
    "free-trial": process.env.STRIPE_FREETRIAL_PRICE_ID,
    "love-basic": process.env.STRIPE_BASIC_PRICE_ID,
    "love-plus": process.env.STRIPE_PLUS_PRICE_ID
};

global.__PRICE_MAP = PRICE_MAP;

console.log("💰 PRICE MAP:", PRICE_MAP);

/***************************************************************
 *  DATABASE INIT (PostgreSQL)
 ***************************************************************/
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
    .catch(err => console.error("❌ DB ERROR:", err));

/***************************************************************
 *  UNIVERSAL HELPERS
 ***************************************************************/
function sanitize(str) {
    return typeof str === "string"
        ? str.replace(/[<>'"]/g, "")
        : str;
}

function signJWT(data) {
    return jwt.sign(data, process.env.JWT_SECRET, {
        expiresIn: "7d"
    });
}

function normalizePlan(productId) {
    if (productId === "free-trial") return "trial";
    if (productId === "love-basic") return "basic";
    if (productId === "love-plus") return "plus";
    return "none";
}

function planLimit(plan) {
    if (plan === "basic") return 3;
    if (plan === "trial") return Infinity;
    if (plan === "plus") return Infinity;
    return 0;
}

global.normalizePlan = normalizePlan;
global.planLimit = planLimit;

/***************************************************************
 *  STRIPE WEBHOOK — MUST BE BEFORE express.json()
 ***************************************************************/
app.post(
    "/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
        try {
            const sig = req.headers["stripe-signature"];

            const event = stripe.webhooks.constructEvent(
                req.body,
                sig,
                process.env.STRIPE_WEBHOOK_SECRET
            );

            console.log("📨 Webhook:", event.type);
            const data = event.data.object;

            const priceToPlan = price => {
                if (price === PRICE_MAP["free-trial"]) return "trial";
                if (price === PRICE_MAP["love-basic"]) return "basic";
                if (price === PRICE_MAP["love-plus"]) return "plus";
                return "none";
            };

            /******************************
             * CHECKOUT COMPLETED
             ******************************/
            if (event.type === "checkout.session.completed") {
                if (data.mode !== "subscription") return res.sendStatus(200);

                const customerId = data.metadata.customer_id;
                const subId = data.subscription;

                const stripeSub = await stripe.subscriptions.retrieve(subId);
                const plan = priceToPlan(stripeSub.items.data[0].price.id);

                await pool.query(
                    `
                    UPDATE customers SET
                        has_subscription = TRUE,
                        current_plan = $1,
                        stripe_subscription_id = $2,
                        subscription_end = NULL
                    WHERE id = $3
                    `,
                    [plan, subId, customerId]
                );

                console.log("✅ Checkout Completed:", plan);
            }

            /******************************
             * SUB CREATED
             ******************************/
            if (event.type === "customer.subscription.created") {
                const plan = priceToPlan(data.items.data[0].price.id);

                await pool.query(
                    `
                    UPDATE customers SET
                        has_subscription = TRUE,
                        current_plan = $1,
                        stripe_subscription_id = $2,
                        subscription_end = NULL
                    WHERE stripe_customer_id = $3
                    `,
                    [plan, data.id, data.customer]
                );

                console.log("➕ Subscription Created:", plan);
            }

            /******************************
             * SUB UPDATED (upgrade/downgrade)
             ******************************/
            if (event.type === "customer.subscription.updated") {
                const plan = priceToPlan(data.items.data[0].price.id);

                await pool.query(
                    `
                    UPDATE customers SET
                        has_subscription = TRUE,
                        current_plan = $1,
                        subscription_end = NULL
                    WHERE stripe_customer_id = $2
                    `,
                    [plan, data.customer]
                );

                console.log("🔄 Subscription Updated:", plan);
            }

            /******************************
             * SUB DELETED (canceled)
             ******************************/
            if (event.type === "customer.subscription.deleted") {
                const end = data.ended_at
                    ? new Date(data.ended_at * 1000)
                    : new Date();

                await pool.query(
                    `
                    UPDATE customers SET
                        has_subscription = FALSE,
                        current_plan = 'none',
                        stripe_subscription_id = NULL,
                        subscription_end = $1
                    WHERE stripe_customer_id = $2
                    `,
                    [end, data.customer]
                );

                console.log("❌ Subscription Deleted");
            }

            return res.sendStatus(200);

        } catch (err) {
            console.error("❌ WEBHOOK ERROR:", err);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }
    }
);

/***************************************************************
 * END PART 1 — REPLY “part 2”
 ***************************************************************/
/***************************************************************
 *  LoveTextForHer — Backend (Part 2 / 7)
 *  ------------------------------------------------------------
 *  ✔ Middleware (AFTER webhook)
 *  ✔ CORS for Render frontend
 *  ✔ Static files
 *  ✔ Customer & Admin auth
 *  ✔ Admin seeding
 *  ✔ Register/Login/Logout
 ***************************************************************/

/***************************************************************
 *  MIDDLEWARE — MUST COME AFTER WEBHOOK
 ***************************************************************/
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

app.use(cors({
    origin: process.env.FRONTEND_URL,
    credentials: true
}));

app.use(express.static(path.join(__dirname, "public")));

/***************************************************************
 *  JWT AUTH — CUSTOMER
 ***************************************************************/
global.authCustomer = (req, res, next) => {
    try {
        const token = req.cookies.customer_token;
        if (!token) return res.status(401).json({ error: "Not logged in" });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role !== "customer") throw new Error("Wrong role");

        req.user = decoded;
        next();

    } catch (err) {
        res.clearCookie("customer_token", {
            httpOnly: true,
            secure: true,
            sameSite: "none",
            path: "/",
        });
        return res.status(401).json({ error: "Invalid session" });
    }
};

/***************************************************************
 *  JWT AUTH — ADMIN
 ***************************************************************/
global.authAdmin = (req, res, next) => {
    try {
        const token = req.cookies.admin_token;
        if (!token) return res.status(401).json({ error: "Not logged in" });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role !== "admin") throw new Error("Wrong role");

        req.admin = decoded;
        next();

    } catch (err) {
        res.clearCookie("admin_token", {
            httpOnly: true,
            secure: true,
            sameSite: "none",
            path: "/",
        });
        return res.status(401).json({ error: "Invalid admin session" });
    }
};

/***************************************************************
 *  SEED DEFAULT ADMIN (FIRST RUN)
 ***************************************************************/
async function seedAdmin() {
    try {
        const q = await pool.query("SELECT id FROM admins LIMIT 1");

        if (q.rows.length === 0) {
            const hash = await bcrypt.hash("Admin123!", 10);
            await pool.query(
                `INSERT INTO admins (email, password_hash)
                 VALUES ($1, $2)`,
                ["admin@lovetextforher.com", hash]
            );
            console.log("🌟 Default admin created");
        }
    } catch (err) {
        console.error("❌ ADMIN SEED ERROR:", err);
    }
}
seedAdmin();

/***************************************************************
 *  CUSTOMER REGISTER
 ***************************************************************/
app.post("/api/customer/register", async (req, res) => {
    try {
        let { name, email, password } = req.body;

        name = sanitize(name);
        email = sanitize(email);

        if (!name || !email || !password)
            return res.status(400).json({ error: "All fields required" });

        if (password.length < 6)
            return res.status(400).json({ error: "Password too short" });

        // Check duplicate
        const ex = await pool.query(
            "SELECT id FROM customers WHERE email=$1",
            [email]
        );

        if (ex.rows.length > 0)
            return res.status(400).json({ error: "Email already exists" });

        const hash = await bcrypt.hash(password, 10);

        await pool.query(
            `
            INSERT INTO customers
            (name, email, password_hash,
             has_subscription, current_plan,
             stripe_customer_id, stripe_subscription_id,
             subscription_end)
            VALUES ($1,$2,$3,false,'none',NULL,NULL,NULL)
            `,
            [name, email, hash]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("REGISTER ERROR:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/***************************************************************
 *  CUSTOMER LOGIN
 ***************************************************************/
app.post("/api/customer/login", async (req, res) => {
    try {
        let { email, password } = req.body;
        email = sanitize(email);

        const q = await pool.query(
            "SELECT * FROM customers WHERE email=$1",
            [email]
        );

        if (!q.rows.length)
            return res.status(400).json({ error: "Invalid credentials" });

        const customer = q.rows[0];

        const valid = await bcrypt.compare(password, customer.password_hash);
        if (!valid)
            return res.status(400).json({ error: "Invalid credentials" });

        const token = signJWT({
            id: customer.id,
            email: customer.email,
            role: "customer"
        });

        res.cookie("customer_token", token, {
            httpOnly: true,
            secure: true,
            sameSite: "none",
            path: "/",
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        return res.json({ success: true });

    } catch (err) {
        console.error("LOGIN ERROR:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/***************************************************************
 *  CUSTOMER LOGOUT
 ***************************************************************/
app.post("/api/customer/logout", (req, res) => {
    res.clearCookie("customer_token", {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/"
    });

    return res.json({ success: true });
});

/***************************************************************
 *  ADMIN LOGIN
 ***************************************************************/
app.post("/api/admin/login", async (req, res) => {
    try {
        let { email, password } = req.body;
        email = sanitize(email);

        const q = await pool.query(
            "SELECT * FROM admins WHERE email=$1",
            [email]
        );

        if (!q.rows.length)
            return res.status(400).json({ error: "Invalid credentials" });

        const admin = q.rows[0];

        const valid = await bcrypt.compare(password, admin.password_hash);
        if (!valid)
            return res.status(400).json({ error: "Invalid credentials" });

        const token = signJWT({
            id: admin.id,
            email: admin.email,
            role: "admin"
        });

        res.cookie("admin_token", token, {
            httpOnly: true,
            secure: true,
            sameSite: "none",
            path: "/",
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        return res.json({ success: true });

    } catch (err) {
        console.error("ADMIN LOGIN ERROR:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/***************************************************************
 *  ADMIN LOGOUT
 ***************************************************************/
app.post("/api/admin/logout", (req, res) => {
    res.clearCookie("admin_token", {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/"
    });

    return res.json({ success: true });
});

/***************************************************************
 *  CUSTOMER /me
 ***************************************************************/
app.get("/api/customer/me", authCustomer, async (req, res) => {
    try {
        const q = await pool.query(
            `
            SELECT id, name, email, has_subscription, current_plan,
                   stripe_customer_id, stripe_subscription_id,
                   subscription_end
            FROM customers
            WHERE id=$1
            `,
            [req.user.id]
        );

        return res.json({ customer: q.rows[0] });

    } catch (err) {
        console.error("/me ERROR:", err);
        return res.json({ customer: null });
    }
});

/***************************************************************
 *  ADMIN /me
 ***************************************************************/
app.get("/api/admin/me", authAdmin, (req, res) => {
    return res.json({
        admin: {
            id: req.admin.id,
            email: req.admin.email,
            role: "admin"
        }
    });
});

/***************************************************************
 *  END PART 2 — Reply “part 3”
 ***************************************************************/
/***************************************************************
 *  LoveTextForHer — Backend (Part 3 / 7)
 *  ------------------------------------------------------------
 *  ✔ Message templates
 *  ✔ Message builder
 *  ✔ Email generator
 *  ✔ Plan normalization & limits
 *  ✔ Enforce limits after downgrade
 *  ✔ Message logs
 ***************************************************************/

/***************************************************************
 *  UNIVERSAL MESSAGE TEMPLATES (relationship-aware)
 ***************************************************************/
const MESSAGE_TEMPLATES = {
    spouse: [
        "Hey {name}, your partner loves you deeply ❤️",
        "{name}, you're appreciated more than you know 💍",
        "Your spouse is thinking about you right now 💕"
    ],
    girlfriend: [
        "{name}, you are loved more every single day 💖",
        "Someone can’t stop thinking about you 🌹",
        "A reminder that you're adored, {name} ❤️"
    ],
    boyfriend: [
        "Hey {name}, someone is proud of you 💙",
        "You're appreciated more than you know 💌",
        "Someone loves you like crazy, {name} 😘"
    ],
    mom: [
        "{name}, you are the heart of your family ❤️",
        "You mean more than words can say 🌷",
        "Sending appreciation your way, {name} 💞"
    ],
    dad: [
        "{name}, you're stronger than you realize 💙",
        "Someone appreciates everything you do 💪",
        "You are loved, {name} 💌"
    ],
    sister: [
        "{name}, you're an amazing sister 💕",
        "Someone is grateful for you ✨",
        "You're loved and appreciated 💖"
    ],
    brother: [
        "{name}, someone is proud of you ❤️",
        "You're appreciated more than you know 💙",
        "You matter, {name} 💌"
    ],
    friend: [
        "Hey {name}, you're a great friend 😊",
        "Someone is thinking about you 💛",
        "Sending a little love your way ✨"
    ],
    default: [
        "Hey {name}, someone cares about you ❤️",
        "A message to brighten your day ✨",
        "Sending a little love your way 💌"
    ]
};

/***************************************************************
 *  BUILD LOVE MESSAGE (relationship-aware)
 ***************************************************************/
function buildLoveMessage(name, relationship) {
    const clean = sanitize(name);

    const group = MESSAGE_TEMPLATES[relationship?.toLowerCase()] ||
                  MESSAGE_TEMPLATES.default;

    const template = group[Math.floor(Math.random() * group.length)];

    return template.replace("{name}", clean);
}

global.buildLoveMessage = buildLoveMessage;

/***************************************************************
 *  EMAIL HTML TEMPLATE
 ***************************************************************/
function buildLoveEmailHTML(name, message, unsubscribeURL) {
    return `
        <div style="font-family:Arial;padding:20px;">
            <h2 style="color:#d6336c;">Hello ${sanitize(name)} ❤️</h2>

            <p style="font-size:16px;line-height:1.6;">
                ${sanitize(message)}
            </p>

            <br>

            <a href="${unsubscribeURL}"
               style="color:#777;font-size:12px;text-decoration:none;">
                Unsubscribe from messages
            </a>
        </div>
    `;
}
global.buildLoveEmailHTML = buildLoveEmailHTML;

/***************************************************************
 *  PLAN NORMALIZATION
 ***************************************************************/
function normalizePlan(productId) {
    if (productId === "free-trial") return "trial";
    if (productId === "love-basic") return "basic";
    if (productId === "love-plus") return "plus";
    return "none";
}
global.normalizePlan = normalizePlan;

/***************************************************************
 *  PLAN LIMITS
 *  trial = ∞
 *  basic = 3
 *  plus  = ∞
 ***************************************************************/
function getRecipientLimit(plan) {
    if (plan === "trial") return Infinity;
    if (plan === "plus") return Infinity;
    if (plan === "basic") return 3;
    return 0;
}
global.getRecipientLimit = getRecipientLimit;

/***************************************************************
 *  ENFORCE LIMITS (after downgrade)
 ***************************************************************/
async function enforceRecipientLimit(customerId, plan) {
    const limit = getRecipientLimit(plan);
    if (limit === Infinity) return;

    const q = await pool.query(
        `SELECT id FROM users
         WHERE customer_id=$1
         ORDER BY id ASC`,
        [customerId]
    );

    const recipients = q.rows;

    if (recipients.length <= limit) return;

    // Remove oldest ones until within limit
    const toDelete = recipients.slice(0, recipients.length - limit);
    const ids = toDelete.map(r => r.id);

    await pool.query(
        `DELETE FROM users WHERE id = ANY($1)`,
        [ids]
    );

    console.log(`⚠️ Removed ${ids.length} recipients (limit enforcement)`);
}

global.enforceRecipientLimit = enforceRecipientLimit;

/***************************************************************
 *  MESSAGE LOGGING
 ***************************************************************/
global.logMessage = async function (customerId, recipientId, email, message) {
    try {
        await pool.query(
            `
            INSERT INTO message_logs (customer_id, recipient_id, email, message)
            VALUES ($1,$2,$3,$4)
            `,
            [customerId, recipientId, email, message]
        );
    } catch (err) {
        console.error("❌ LOG MESSAGE ERROR:", err);
    }
};

/***************************************************************
 *  END PART 3 — Reply “part 4”
 ***************************************************************/
/***************************************************************
 *  LoveTextForHer — Backend (Part 4 / 7)
 *  ------------------------------------------------------------
 *  ✔ Customer register/login/logout
 *  ✔ Admin login/logout
 *  ✔ JWT middleware for customer/admin
 *  ✔ /me endpoints
 ***************************************************************/

/***************************************************************
 *  CUSTOMER REGISTER
 ***************************************************************/
app.post("/api/customer/register", async (req, res) => {
    try {
        let { name, email, password } = req.body;

        name = sanitize(name);
        email = sanitize(email);

        if (!name || !email || !password)
            return res.status(400).json({ error: "All fields required" });

        if (password.length < 6)
            return res.status(400).json({ error: "Password too short" });

        const exists = await pool.query(
            "SELECT id FROM customers WHERE email=$1",
            [email]
        );

        if (exists.rows.length)
            return res.status(400).json({ error: "Email already exists" });

        const hash = await bcrypt.hash(password, 10);

        await pool.query(
            `
            INSERT INTO customers
                (name, email, password_hash,
                 has_subscription, current_plan,
                 stripe_customer_id, stripe_subscription_id,
                 subscription_end)
            VALUES ($1,$2,$3,false,'none',NULL,NULL,NULL)
            `,
            [name, email, hash]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("REGISTER ERROR:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/***************************************************************
 *  CUSTOMER LOGIN
 ***************************************************************/
app.post("/api/customer/login", async (req, res) => {
    try {
        let { email, password } = req.body;

        email = sanitize(email);

        const q = await pool.query(
            "SELECT * FROM customers WHERE email=$1",
            [email]
        );

        if (!q.rows.length)
            return res.status(400).json({ error: "Invalid credentials" });

        const customer = q.rows[0];

        const valid = await bcrypt.compare(password, customer.password_hash);
        if (!valid)
            return res.status(400).json({ error: "Invalid credentials" });

        const token = signJWT({
            id: customer.id,
            email: customer.email,
            role: "customer"
        });

        // Secure cookie
        res.cookie("customer_token", token, {
            httpOnly: true,
            secure: true,      // required on Render
            sameSite: "none",  // required for cross-origin cookie
            path: "/",
            maxAge: 7 * 86400 * 1000
        });

        return res.json({ success: true });

    } catch (err) {
        console.error("LOGIN ERROR:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/***************************************************************
 *  CUSTOMER LOGOUT
 ***************************************************************/
app.post("/api/customer/logout", (req, res) => {
    res.clearCookie("customer_token", {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/"
    });

    return res.json({ success: true });
});

/***************************************************************
 *  ADMIN LOGIN
 ***************************************************************/
app.post("/api/admin/login", async (req, res) => {
    try {
        let { email, password } = req.body;

        email = sanitize(email);

        const q = await pool.query(
            "SELECT * FROM admins WHERE email=$1",
            [email]
        );

        if (!q.rows.length)
            return res.status(400).json({ error: "Invalid credentials" });

        const admin = q.rows[0];

        const valid = await bcrypt.compare(password, admin.password_hash);
        if (!valid)
            return res.status(400).json({ error: "Invalid credentials" });

        const token = signJWT({
            id: admin.id,
            email: admin.email,
            role: "admin"
        });

        res.cookie("admin_token", token, {
            httpOnly: true,
            secure: true,
            sameSite: "none",
            path: "/",
            maxAge: 7 * 86400 * 1000
        });

        return res.json({ success: true });

    } catch (err) {
        console.error("ADMIN LOGIN ERROR:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/***************************************************************
 *  ADMIN LOGOUT
 ***************************************************************/
app.post("/api/admin/logout", (req, res) => {
    res.clearCookie("admin_token", {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/"
    });

    return res.json({ success: true });
});

/***************************************************************
 *  CUSTOMER AUTH MIDDLEWARE
 ***************************************************************/
global.authCustomer = function (req, res, next) {
    try {
        const token = req.cookies.customer_token;
        if (!token)
            return res.status(401).json({ error: "Not logged in" });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role !== "customer")
            throw new Error("Invalid role");

        req.user = decoded;
        next();

    } catch (err) {
        res.clearCookie("customer_token", {
            httpOnly: true,
            secure: true,
            sameSite: "none",
            path: "/"
        });

        return res.status(401).json({ error: "Invalid session" });
    }
};

/***************************************************************
 *  ADMIN AUTH MIDDLEWARE
 ***************************************************************/
global.authAdmin = function (req, res, next) {
    try {
        const token = req.cookies.admin_token;
        if (!token)
            return res.status(401).json({ error: "Not logged in" });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role !== "admin")
            throw new Error("Invalid role");

        req.admin = decoded;
        next();

    } catch (err) {
        res.clearCookie("admin_token", {
            httpOnly: true,
            secure: true,
            sameSite: "none",
            path: "/"
        });

        return res.status(401).json({ error: "Invalid session" });
    }
};

/***************************************************************
 *  CUSTOMER /me ENDPOINT
 ***************************************************************/
app.get("/api/customer/me", authCustomer, async (req, res) => {
    try {
        const q = await pool.query(
            `SELECT id, name, email, has_subscription, current_plan
             FROM customers
             WHERE id=$1`,
            [req.user.id]
        );

        return res.json({ customer: q.rows[0] });

    } catch (err) {
        console.error("/me ERROR:", err);
        return res.status(500).json({ customer: null });
    }
});

/***************************************************************
 *  ADMIN /me ENDPOINT
 ***************************************************************/
app.get("/api/admin/me", authAdmin, (req, res) => {
    return res.json({
        admin: {
            id: req.admin.id,
            email: req.admin.email,
            role: "admin"
        }
    });
});

/***************************************************************
 *  END PART 4 — Reply “part 5”
 ***************************************************************/
/***************************************************************
 *  LoveTextForHer — Backend (Part 5 / 7)
 *  ------------------------------------------------------------
 *  ✔ Recipients (list/add/delete)
 *  ✔ Subscription plan limits
 *  ✔ Message logs
 *  ✔ Flower sending
 *  ✔ Public unsubscribe link
 *  ✔ Admin recipient management
 ***************************************************************/

/***************************************************************
 *  COUNT RECIPIENTS FOR CUSTOMER
 ***************************************************************/
async function countRecipients(customerId) {
    const q = await pool.query(
        "SELECT COUNT(*) FROM users WHERE customer_id=$1",
        [customerId]
    );
    return Number(q.rows[0].count);
}

/***************************************************************
 *  GET CUSTOMER RECIPIENT LIST
 ***************************************************************/
app.get("/api/customer/recipients", authCustomer, async (req, res) => {
    try {
        const q = await pool.query(
            `
            SELECT 
                id, email, name, relationship,
                frequency, timings, timezone,
                next_delivery, last_sent, is_active
            FROM users
            WHERE customer_id=$1
            ORDER BY id DESC
            `,
            [req.user.id]
        );

        return res.json(q.rows);

    } catch (err) {
        console.error("RECIPIENT LIST ERROR:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/***************************************************************
 *  ADD RECIPIENT (WITH PLAN LIMIT)
 ***************************************************************/
app.post("/api/customer/recipients", authCustomer, async (req, res) => {
    try {
        const userQ = await pool.query(
            "SELECT current_plan FROM customers WHERE id=$1",
            [req.user.id]
        );

        if (!userQ.rows.length)
            return res.status(404).json({ error: "Customer not found" });

        const plan = userQ.rows[0].current_plan;
        const maxAllowed = getRecipientLimit(plan);
        const current = await countRecipients(req.user.id);

        if (current >= maxAllowed) {
            return res.status(400).json({
                error: "Your subscription plan does not allow more recipients."
            });
        }

        // Sanitize input
        let {
            name,
            email,
            relationship,
            frequency,
            timings,
            timezone
        } = req.body;

        name = sanitize(name);
        email = sanitize(email);
        relationship = sanitize(relationship);
        frequency = sanitize(frequency);
        timings = sanitize(timings);
        timezone = sanitize(timezone);

        if (!name || !email)
            return res.status(400).json({ error: "Name & email required" });

        const unsubscribeToken = crypto.randomBytes(16).toString("hex");

        await pool.query(
            `
            INSERT INTO users
                (email, customer_id, name, relationship,
                 frequency, timings, timezone,
                 unsubscribe_token,
                 is_active, next_delivery, created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,NOW(),NOW())
            `,
            [
                email,
                req.user.id,
                name,
                relationship,
                frequency,
                timings,
                timezone,
                unsubscribeToken
            ]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("ADD RECIPIENT ERROR:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/***************************************************************
 *  DELETE RECIPIENT
 ***************************************************************/
app.delete("/api/customer/recipients/:id", authCustomer, async (req, res) => {
    try {
        await pool.query(
            "DELETE FROM users WHERE id=$1 AND customer_id=$2",
            [req.params.id, req.user.id]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("DELETE RECIP ERROR:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/***************************************************************
 *  GET MESSAGE LOG (LAST 5)
 ***************************************************************/
app.get("/api/message-log/:rid", authCustomer, async (req, res) => {
    try {
        const rid = req.params.rid;

        const q = await pool.query(
            `
            SELECT message AS message_text, sent_at
            FROM message_logs
            WHERE customer_id=$1 AND recipient_id=$2
            ORDER BY sent_at DESC
            LIMIT 5
            `,
            [req.user.id, rid]
        );

        return res.json({ success: true, messages: q.rows });

    } catch (err) {
        console.error("MESSAGE LOG ERROR:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/***************************************************************
 *  SEND FLOWER TO RECIPIENT
 ***************************************************************/
app.post("/api/customer/send-flowers/:id", authCustomer, async (req, res) => {
    try {
        const rid = req.params.id;
        const { note } = req.body;

        const q = await pool.query(
            "SELECT * FROM users WHERE id=$1 AND customer_id=$2",
            [rid, req.user.id]
        );

        if (!q.rows.length)
            return res.status(404).json({ error: "Recipient not found" });

        const r = q.rows[0];

        const unsubscribeURL =
            `${process.env.BASE_URL}/unsubscribe.html?token=${r.unsubscribe_token}`;

        const message = "🌸 You received a flower!" +
            (note?.trim() ? ` — ${sanitize(note)}` : "");

        const html = buildLoveEmailHTML(r.name, message, unsubscribeURL);

        await sendEmail(
            r.email,
            "You received a flower 🌸",
            html,
            message + "\n\nUnsubscribe: " + unsubscribeURL
        );

        // Log flower
        await pool.query(
            `
            INSERT INTO message_logs (customer_id, recipient_id, email, message)
            VALUES ($1,$2,$3,$4)
            `,
            [req.user.id, rid, r.email, message]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("FLOWER SEND ERROR:", err);
        return res.status(500).json({ error: "Error sending flower" });
    }
});

/***************************************************************
 *  PUBLIC UNSUBSCRIBE
 ***************************************************************/
app.get("/api/unsubscribe/:token", async (req, res) => {
    try {
        const token = req.params.token;

        const q = await pool.query(
            "SELECT id FROM users WHERE unsubscribe_token=$1",
            [token]
        );

        if (!q.rows.length)
            return res.status(404).send("Invalid link");

        await pool.query(
            "UPDATE users SET is_active=false WHERE id=$1",
            [q.rows[0].id]
        );

        return res.send(`
            <h2 style="font-family:Arial;">You've been unsubscribed ❤️</h2>
            <p style="font-family:Arial;">You will no longer receive messages.</p>
        `);

    } catch (err) {
        console.error("UNSUBSCRIBE ERROR:", err);
        return res.status(500).send("Server error");
    }
});

/***************************************************************
 *  ADMIN — GET ALL RECIPIENTS
 ***************************************************************/
app.get("/api/admin/recipients", authAdmin, async (req, res) => {
    try {
        const q = await pool.query(
            `
            SELECT
                id, customer_id, email, name,
                relationship, frequency, timings, timezone,
                next_delivery, last_sent, is_active
            FROM users
            ORDER BY id DESC
            `
        );

        return res.json(q.rows);

    } catch (err) {
        console.error("ADMIN RECIPIENT ERROR:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/***************************************************************
 *  ADMIN — DELETE ANY RECIPIENT
 ***************************************************************/
app.delete("/api/admin/recipients/:id", authAdmin, async (req, res) => {
    try {
        await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);
        return res.json({ success: true });

    } catch (err) {
        console.error("ADMIN DELETE ERROR:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/***************************************************************
 *  ADMIN — SEND MESSAGE NOW (IMMEDIATE OVERRIDE)
 ***************************************************************/
app.post("/api/admin/send-now/:id", authAdmin, async (req, res) => {
    try {
        const rid = req.params.id;

        const q = await pool.query(
            "SELECT * FROM users WHERE id=$1",
            [rid]
        );

        if (!q.rows.length)
            return res.status(404).json({ error: "Recipient not found" });

        const r = q.rows[0];

        const unsubscribeURL =
            `${process.env.BASE_URL}/unsubscribe.html?token=${r.unsubscribe_token}`;

        const msg = buildMessage(r.name, r.relationship);

        const html = buildLoveEmailHTML(r.name, msg, unsubscribeURL);

        await sendEmail(
            r.email,
            "A Love Message For You ❤️",
            html,
            msg + "\n\nUnsubscribe: " + unsubscribeURL
        );

        // Log
        await pool.query(
            `
            INSERT INTO message_logs (customer_id, recipient_id, email, message)
            VALUES ($1,$2,$3,$4)
            `,
            [r.customer_id, r.id, r.email, msg]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("ADMIN SEND-NOW ERROR:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/***************************************************************
 *  END PART 5 — reply “part 6”
 ***************************************************************/
/***************************************************************
 *  LoveTextForHer — Backend (Part 6 / 7)
 *  ------------------------------------------------------------
 *  ✔ Relationship-aware romantic message builder
 *  ✔ HTML email builder
 *  ✔ Resend + Brevo fallback sender
 *  ✔ Final recipient limit map
 *  ✔ Cron scheduler (every 5 minutes)
 ***************************************************************/

/***************************************************************
 *  MESSAGE BUILDER (relationship-aware)
 ***************************************************************/
function buildMessage(name, relationship) {
    const cleanName = sanitize(name);

    // Base messages shown to everyone
    const base = [
        `Hey ${cleanName}, someone is thinking about you right now ❤️`,
        `${cleanName}, you deserve love, joy, and kindness today 🌸`,
        `A reminder for ${cleanName}: you're appreciated more than you know 💕`,
        `${cleanName}, you brighten someone's world ✨`,
        `You matter deeply to someone today, ${cleanName} 💖`
    ];

    const extras = {
        spouse: [
            "Your partner loves you more than words can say 💍💕",
            "You mean the world to your spouse ❤️"
        ],
        girlfriend: [
            "Your boyfriend wants you to know you're his greatest blessing 💖",
            "You are loved more than you will ever realize 💕"
        ],
        boyfriend: [
            "Your girlfriend wants you to know you mean everything to her ❤️",
            "You are strong, valued, and deeply loved 💙"
        ],
        mom: [
            "Your child wants you to know how much they appreciate you ❤️",
            "You are the heart of your family 💐"
        ],
        dad: [
            "Your child appreciates everything you do 💙",
            "Your strength means the world to your family 👨‍👧‍👦"
        ],
        sister: [
            "A sibling who loves you wanted you to smile today 💕",
            "You're the best sister anyone could ask for 🎀"
        ],
        brother: [
            "Someone who admires you wanted you to know you're amazing 💙",
            "Best brother award goes to you 🏆"
        ],
        friend: [
            "A friend who cares about you wanted to brighten your day 😊",
            "You're the kind of friend everyone wishes they had 💛"
        ]
    };

    // Pick random base message
    let msg = base[Math.floor(Math.random() * base.length)];

    // Add relationship extra
    if (extras[relationship]) {
        const arr = extras[relationship];
        msg += " " + arr[Math.floor(Math.random() * arr.length)];
    }

    return msg;
}
global.buildMessage = buildMessage;


/***************************************************************
 *  EMAIL HTML BUILDER
 ***************************************************************/
function buildLoveEmailHTML(name, message, unsubscribeURL) {
    return `
        <div style="font-family:Arial;padding:25px;background:#fff3f8;
                     color:#d6336c;border-radius:14px;">
            <h2 style="margin-top:0;">A Message for ${sanitize(name)} ❤️</h2>

            <p style="font-size:17px;line-height:1.6;">
                ${sanitize(message)}
            </p>

            <br>

            <a href="${unsubscribeURL}"
                style="color:#777;font-size:13px;text-decoration:none;">
                Unsubscribe from these messages
            </a>
        </div>
    `;
}
global.buildLoveEmailHTML = buildLoveEmailHTML;


/***************************************************************
 *  EMAIL SENDER — Resend (primary) + Brevo fallback
 ***************************************************************/
async function sendEmail(to, subject, html, text) {
    // Try Resend first
    try {
        const result = await resend.emails.send({
            from: process.env.FROM_EMAIL,
            to,
            subject,
            html,
            text
        });

        if (result?.id) {
            console.log("📧 Sent via Resend:", result.id);
            return true;
        }

    } catch (err) {
        console.warn("⚠ Resend failed:", err.message);
    }

    // Fallback to Brevo SMTP
    try {
        const transporter = nodemailer.createTransport({
            host: "smtp-relay.brevo.com",
            port: 587,
            secure: false,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });

        await transporter.sendMail({
            from: process.env.FROM_EMAIL,
            to,
            subject,
            html,
            text
        });

        console.log("📧 Sent via Brevo fallback");
        return true;

    } catch (err) {
        console.error("❌ Email FAILED:", err);
        return false;
    }
}
global.sendEmail = sendEmail;


/***************************************************************
 *  FINAL RECIPIENT LIMITS
 ***************************************************************/
function getRecipientLimit(plan) {
    if (plan === "trial") return Infinity;   // free trial = unlimited
    if (plan === "plus") return Infinity;    // premium = unlimited
    if (plan === "basic") return 3;          // basic = max 3
    return 0;                                // no plan = none
}
global.getRecipientLimit = getRecipientLimit;


/***************************************************************
 *  CRON SCHEDULER — EVERY 5 MINUTES
 ***************************************************************/
cron.schedule("*/5 * * * *", async () => {
    console.log("⏰ CRON: Checking message delivery queue…");

    try {
        const q = await pool.query(`
            SELECT u.*, c.current_plan, c.has_subscription
            FROM users u
            LEFT JOIN customers c ON c.id = u.customer_id
            WHERE u.is_active = true
        `);

        const nowUTC = new Date();

        for (const r of q.rows) {
            // Skip unsubscribed customers
            if (!r.has_subscription) continue;

            // Convert time to recipient timezone
            const localNow = new Date(
                nowUTC.toLocaleString("en-US", { timeZone: r.timezone })
            );
            const hour = localNow.getHours();

            // Time windows
            const windows = {
                morning: [6, 12],
                afternoon: [12, 17],
                evening: [17, 21],
                night: [21, 24]
            };

            const [minH, maxH] = windows[r.timings] || [0, 24];

            // Not in timing window
            if (hour < minH || hour >= maxH) continue;

            // Not due yet
            if (r.next_delivery && new Date(r.next_delivery) > nowUTC) continue;

            // Build message
            const loveMsg = buildMessage(r.name, r.relationship);

            const unsubscribeURL =
                `${process.env.BASE_URL}/unsubscribe.html?token=${r.unsubscribe_token}`;

            const html = buildLoveEmailHTML(r.name, loveMsg, unsubscribeURL);

            // Send the email
            await sendEmail(
                r.email,
                "A Love Message For You ❤️",
                html,
                loveMsg + "\n\nUnsubscribe: " + unsubscribeURL
            );

            // Log the message
            await pool.query(
                `
                INSERT INTO message_logs (customer_id, recipient_id, email, message)
                VALUES ($1,$2,$3,$4)
                `,
                [r.customer_id, r.id, r.email, loveMsg]
            );

            // Calculate next delivery time
            let next = new Date(nowUTC);

            if (r.frequency === "daily") next.setDate(next.getDate() + 1);
            if (r.frequency === "every-other-day") next.setDate(next.getDate() + 2);
            if (r.frequency === "three-times-week") next.setDate(next.getDate() + 2);
            if (r.frequency === "weekly") next.setDate(next.getDate() + 7);
            if (r.frequency === "bi-weekly") next.setDate(next.getDate() + 14);

            await pool.query(
                "UPDATE users SET last_sent=NOW(), next_delivery=$1 WHERE id=$2",
                [next.toISOString(), r.id]
            );

            console.log(`✔ Message sent → ${r.email}`);
        }

    } catch (err) {
        console.error("❌ CRON ERROR:", err);
    }
});

/***************************************************************
 *  END OF PART 6 — Reply “part 7”
 ***************************************************************/
/***************************************************************
 *  PART 7 — Stripe Checkout, Webhooks, Cart, Server Start
 ***************************************************************/

/***************************************************************
 *  STRIPE CHECKOUT — SUBSCRIPTIONS
 ***************************************************************/
app.post("/api/stripe/checkout", requireAuth, async (req, res) => {
    const { productId } = req.body;

    try {
        const PRICE_MAP = {
            "free-trial": process.env.STRIPE_FREETRIAL_PRICE_ID,
            "love-basic": process.env.STRIPE_BASIC_PRICE_ID,
            "love-plus": process.env.STRIPE_PLUS_PRICE_ID
        };

        const price = PRICE_MAP[productId];
        if (!price) return res.json({ error: "Invalid product" });

        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            customer_email: req.customer.email,
            line_items: [
                {
                    price,
                    quantity: 1
                }
            ],
            success_url: `${process.env.FRONTEND_URL}/dashboard.html`,
            cancel_url: `${process.env.FRONTEND_URL}/products.html`,
            subscription_data: {
                metadata: {
                    customer_id: req.customer.id,
                    plan: productId
                }
            },
            metadata: {
                customer_id: req.customer.id,
                plan: productId
            }
        });

        return res.json({ url: session.url });

    } catch (err) {
        console.error("CHECKOUT ERROR:", err);
        return res.json({ error: "Checkout failed." });
    }
});


/***************************************************************
 *  BILLING PORTAL
 ***************************************************************/
app.get("/api/customer/subscription/portal", requireAuth, async (req, res) => {
    try {
        const portal = await stripe.billingPortal.sessions.create({
            customer: req.customer.stripe_customer_id,
            return_url: `${process.env.FRONTEND_URL}/dashboard.html`
        });

        return res.json({ url: portal.url });

    } catch (err) {
        console.error("PORTAL ERROR:", err);
        return res.json({ error: "Unable to open billing portal" });
    }
});


/***************************************************************
 *  STRIPE WEBHOOK — THE MOST IMPORTANT PART
 ***************************************************************/
app.post(
    "/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {

        let event;

        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                req.headers["stripe-signature"],
                process.env.STRIPE_WEBHOOK_SECRET
            );

        } catch (err) {
            console.error("❌ WEBHOOK SIGNATURE ERROR", err.message);
            return res.status(400).send("Webhook error");
        }

        const type = event.type;
        const data = event.data.object;

        try {
            switch (type) {

                /******************************************
                 *  TRIAL / BASIC / PLUS ACTIVATED
                 ******************************************/
                case "customer.subscription.created":
                case "customer.subscription.updated": {
                    const customerId = data.metadata?.customer_id;
                    const plan = data.metadata?.plan;

                    if (!customerId || !plan) break;

                    // Active
                    await pool.query(
                        `
                        UPDATE customers
                        SET has_subscription=true,
                            current_plan=$1,
                            subscription_end=$2
                        WHERE id=$3
                        `,
                        [
                            plan === "free-trial"
                                ? "trial"
                                : plan === "love-basic"
                                ? "basic"
                                : "plus",
                            data.cancel_at ? new Date(data.cancel_at * 1000) : null,
                            customerId
                        ]
                    );

                    console.log("✔ SUB UPDATED:", customerId, plan);
                    break;
                }

                /******************************************
                 *  SUBSCRIPTION CANCELED
                 ******************************************/
                case "customer.subscription.deleted": {
                    const customerId = data.metadata?.customer_id;
                    if (!customerId) break;

                    await pool.query(
                        `
                        UPDATE customers
                        SET has_subscription=false,
                            current_plan='none',
                            subscription_end=NOW()
                        WHERE id=$1
                        `,
                        [customerId]
                    );

                    console.log("❌ SUB CANCELED:", customerId);
                    break;
                }

                /******************************************
                 *  PAYMENT FAILED
                 ******************************************/
                case "invoice.payment_failed": {
                    const customerId = data.metadata?.customer_id;
                    if (!customerId) break;

                    await pool.query(
                        `
                        UPDATE customers
                        SET has_subscription=false
                        WHERE id=$1
                        `,
                        [customerId]
                    );

                    console.log("⚠ PAYMENT FAILED — ACCESS REMOVED:", customerId);
                    break;
                }
            }

            res.status(200).send("OK");

        } catch (err) {
            console.error("❌ WEBHOOK PROCESSING ERROR:", err);
            res.status(500).send("Internal webhook error");
        }
    }
);


/***************************************************************
 *  CART — ADD ITEM
 ***************************************************************/
app.post("/api/cart/add", requireAuth, async (req, res) => {
    const { productId, name, price } = req.body;

    try {
        await pool.query(
            `
            INSERT INTO cart (customer_id, product_id, name, price)
            VALUES ($1,$2,$3,$4)
            `,
            [req.customer.id, productId, name, price]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("CART ADD ERROR:", err);
        return res.json({ error: "Unable to add to cart" });
    }
});


/***************************************************************
 *  CART — GET CONTENTS
 ***************************************************************/
app.get("/api/cart", requireAuth, async (req, res) => {
    try {
        const q = await pool.query(
            `SELECT * FROM cart WHERE customer_id=$1`,
            [req.customer.id]
        );

        res.json({ items: q.rows });

    } catch (err) {
        res.json({ items: [] });
    }
});


/***************************************************************
 *  CART — CHECKOUT (MERCH ONLY)
 ***************************************************************/
app.post("/api/cart/checkout", requireAuth, async (req, res) => {
    try {
        const q = await pool.query(
            `SELECT * FROM cart WHERE customer_id=$1`,
            [req.customer.id]
        );

        if (!q.rows.length)
            return res.json({ error: "Cart empty" });

        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            customer_email: req.customer.email,
            line_items: q.rows.map(x => ({
                price_data: {
                    currency: "usd",
                    product_data: {
                        name: x.name
                    },
                    unit_amount: Math.round(x.price * 100)
                },
                quantity: 1
            })),
            success_url: `${process.env.FRONTEND_URL}/thankyou.html`,
            cancel_url: `${process.env.FRONTEND_URL}/cart.html`
        });

        return res.json({ url: session.url });

    } catch (err) {
        console.error("CART PAY ERROR:", err);
        return res.json({ error: "Unable to start payment" });
    }
});


/***************************************************************
 *  START SERVER
 ***************************************************************/
app.listen(PORT, () => {
    console.log(`🚀 LoveTextForHer backend running on ${PORT}`);
});