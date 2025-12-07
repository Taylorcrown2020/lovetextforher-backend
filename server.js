/***************************************************************
 *  LoveTextForHer — Backend (Part 1 / 7)
 *  ------------------------------------------------------------
 *  ✔ Stripe initialized correctly
 *  ✔ Webhook FIRST (before JSON parser)
 *  ✔ PostgreSQL connected
 *  ✔ Helper functions
 *  ✔ Clean base structure
 ***************************************************************/

process.env.TZ = "UTC";
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { Pool } = require("pg");
const path = require("path");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const { Resend } = require("resend");

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

const app = express();
const PORT = process.env.PORT || 3000;

/***************************************************************
 *  PRICE MAP — SINGLE SOURCE OF TRUTH (NO DUPLICATES)
 ***************************************************************/
const PRICE_MAP = {
    "free-trial": process.env.STRIPE_FREETRIAL_PRICE_ID,
    "love-basic": process.env.STRIPE_BASIC_PRICE_ID,
    "love-plus": process.env.STRIPE_PLUS_PRICE_ID
};

console.log("💰 PRICE MAP:", PRICE_MAP);

/***************************************************************
 *  DATABASE — CONNECT CLEANLY
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
    .then(() => console.log("✅ DB Connected"))
    .catch(err => console.error("❌ DB ERROR:", err));

/***************************************************************
 *  UNIVERSAL HELPERS — CLEAN, NO DUPLICATES
 ***************************************************************/
function sanitize(str) {
    return typeof str === "string" ? str.replace(/[<>'"]/g, "") : str;
}

function signJWT(data) {
    return jwt.sign(data, process.env.JWT_SECRET, { expiresIn: "7d" });
}

function normalizePlan(productId) {
    if (productId === "free-trial") return "trial";
    if (productId === "love-basic") return "basic";
    if (productId === "love-plus") return "plus";
    return "none";
}

function getRecipientLimit(plan) {
    if (plan === "basic") return 3;
    if (plan === "trial") return Infinity;
    if (plan === "plus") return Infinity;
    return 0;
}

/***************************************************************
 *  STRIPE WEBHOOK — MUST COME BEFORE ANY JSON BODY PARSER
 ***************************************************************/
app.post(
    "/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
        try {
            const signature = req.headers["stripe-signature"];
            const event = stripe.webhooks.constructEvent(
                req.body,
                signature,
                process.env.STRIPE_WEBHOOK_SECRET
            );

            console.log("📨 Webhook Event:", event.type);
            const data = event.data.object;

            // Map Stripe price → plan
            const mapPriceToPlan = (id) => {
                if (id === PRICE_MAP["free-trial"]) return "trial";
                if (id === PRICE_MAP["love-basic"]) return "basic";
                if (id === PRICE_MAP["love-plus"]) return "plus";
                return "none";
            };

            /***********************************************************
             *  CHECKOUT COMPLETED — FIRST SUBSCRIPTION
             ***********************************************************/
            if (event.type === "checkout.session.completed") {
                if (data.mode !== "subscription") return res.sendStatus(200);

                const customerId = data.metadata.customer_id;
                const subId = data.subscription;

                const stripeSub = await stripe.subscriptions.retrieve(subId);
                const plan = mapPriceToPlan(stripeSub.items.data[0].price.id);

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

                console.log("✅ Checkout Completed →", plan);
            }

            /***********************************************************
             *  SUB CREATED — FIRST TIME
             ***********************************************************/
            if (event.type === "customer.subscription.created") {
                const plan = mapPriceToPlan(data.items.data[0].price.id);

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

                console.log("➕ Subscription Created →", plan);
            }

            /***********************************************************
             *  SUB UPDATED — UPGRADE / DOWNGRADE
             ***********************************************************/
            if (event.type === "customer.subscription.updated") {
                if (data.cancel_at_period_end) {
                    console.log("⏳ Subscription scheduled to cancel");
                    return res.sendStatus(200);
                }

                const plan = mapPriceToPlan(data.items.data[0].price.id);

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

                console.log("🔄 Subscription Updated →", plan);
            }

            /***********************************************************
             *  SUB DELETED — CANCELLED
             ***********************************************************/
            if (event.type === "customer.subscription.deleted") {
                const endDate = data.ended_at
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
                    [endDate, data.customer]
                );

                console.log("❌ Subscription Canceled");
            }

            return res.sendStatus(200);

        } catch (err) {
            console.error("❌ WEBHOOK ERROR:", err);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }
    }
);

/***************************************************************
 *  END OF PART 1 — Reply **"part 2"**
 ***************************************************************/
/***************************************************************
 *  LoveTextForHer — Backend (Part 2 / 7)
 *  ------------------------------------------------------------
 *  ✔ JSON middleware
 *  ✔ CORS for Render frontend
 *  ✔ Cookie parser
 *  ✔ Static public folder
 *  ✔ Customer + Admin auth middleware
 *  ✔ Admin seed (first run)
 *  ✔ Register/Login/Logout routes (clean)
 ***************************************************************/

/***************************************************************
 *  MIDDLEWARE — MUST COME AFTER WEBHOOK
 ***************************************************************/
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

app.use(
    cors({
        origin: process.env.FRONTEND_URL,
        credentials: true
    })
);

app.use(express.static(path.join(__dirname, "public")));

/***************************************************************
 *  AUTH MIDDLEWARE — CUSTOMER
 ***************************************************************/
function requireCustomer(req, res, next) {
    try {
        const token = req.cookies.customer_token;
        if (!token) return res.status(401).json({ error: "Not logged in" });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role !== "customer") throw new Error("Invalid role");

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
}

/***************************************************************
 *  AUTH MIDDLEWARE — ADMIN
 ***************************************************************/
function requireAdmin(req, res, next) {
    try {
        const token = req.cookies.admin_token;
        if (!token) return res.status(401).json({ error: "Not logged in" });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role !== "admin") throw new Error("Invalid role");

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
}

/***************************************************************
 *  SEED DEFAULT ADMIN (first deploy only)
 ***************************************************************/
async function seedAdmin() {
    try {
        const check = await pool.query("SELECT id FROM admins LIMIT 1");

        if (check.rows.length === 0) {
            const passwordHash = await bcrypt.hash("Admin123!", 10);

            await pool.query(
                `
                INSERT INTO admins (email, password_hash)
                VALUES ($1, $2)
                `,
                ["admin@lovetextforher.com", passwordHash]
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

        const exists = await pool.query(
            "SELECT id FROM customers WHERE email=$1",
            [email]
        );

        if (exists.rows.length > 0)
            return res.status(400).json({ error: "Email already exists" });

        const hash = await bcrypt.hash(password, 10);

        await pool.query(
            `
            INSERT INTO customers
            (name, email, password_hash,
             has_subscription, current_plan,
             stripe_customer_id, stripe_subscription_id, subscription_end)
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
 *  CUSTOMER /me
 ***************************************************************/
app.get("/api/customer/me", requireCustomer, async (req, res) => {
    try {
        const q = await pool.query(
            `
            SELECT id, name, email, has_subscription, current_plan
            FROM customers
            WHERE id=$1
            `,
            [req.user.id]
        );

        return res.json({ customer: q.rows[0] });
    } catch (err) {
        console.error("CUSTOMER /me ERROR:", err);
        return res.json({ customer: null });
    }
});

/***************************************************************
 *  ADMIN /me
 ***************************************************************/
app.get("/api/admin/me", requireAdmin, (req, res) => {
    return res.json({ admin: req.admin });
});

/***************************************************************
 *  END PART 2 — reply **"part 3"**
 ***************************************************************/
/***************************************************************
 *  LoveTextForHer — Backend (Part 3 / 7)
 *  ------------------------------------------------------------
 *  ✔ Message templates
 *  ✔ Love message builder
 *  ✔ Email HTML builder
 *  ✔ Plan normalization
 *  ✔ Plan limits (trial/unlimited/basic=3)
 *  ✔ Enforce limits after downgrade
 *  ✔ Message logging
 ***************************************************************/

/***************************************************************
 *  MESSAGE TEMPLATES
 ***************************************************************/
const MESSAGE_TEMPLATES = {
    spouse: [
        "Hey {name}, your partner loves you deeply ❤️",
        "{name}, you are appreciated more than you know 💍",
        "Your spouse is thinking about you right now 💕"
    ],
    girlfriend: [
        "{name}, you are loved more every single day 💖",
        "Someone can't stop thinking about you 🌹",
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
 *  BUILD LOVE MESSAGE
 ***************************************************************/
function buildLoveMessage(name, relationship) {
    const group =
        MESSAGE_TEMPLATES[relationship?.toLowerCase()] ||
        MESSAGE_TEMPLATES.default;

    const message =
        group[Math.floor(Math.random() * group.length)];

    return message.replace("{name}", sanitize(name));
}

global.buildLoveMessage = buildLoveMessage;

/***************************************************************
 *  EMAIL TEMPLATE BUILDER
 ***************************************************************/
function buildLoveEmailHTML(name, message, unsubscribeURL) {
    return `
        <div style="font-family:Arial;padding:25px;background:#fff3f8;border-radius:14px;">
            <h2 style="margin:0;color:#d6336c;">
                A Message For ${sanitize(name)} ❤️
            </h2>

            <p style="font-size:17px;line-height:1.6;color:#333;">
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
 ***************************************************************/
function getRecipientLimit(plan) {
    if (plan === "plus") return Infinity;
    if (plan === "trial") return Infinity;
    if (plan === "basic") return 3;
    return 0;
}

global.getRecipientLimit = getRecipientLimit;

/***************************************************************
 *  ENFORCE RECIPIENT LIMIT — after downgrade
 ***************************************************************/
async function enforceRecipientLimit(customerId, plan) {
    const limit = getRecipientLimit(plan);

    if (limit === Infinity) return;

    const q = await pool.query(
        `SELECT id FROM users 
         WHERE customer_id = $1 
         ORDER BY id ASC`,
        [customerId]
    );

    const recipients = q.rows;

    if (recipients.length <= limit) return;

    const remove = recipients.slice(0, recipients.length - limit);
    const ids = remove.map(r => r.id);

    await pool.query(
        "DELETE FROM users WHERE id = ANY($1)",
        [ids]
    );

    console.log(`⚠️ Removed ${ids.length} recipients (plan limit enforced)`);
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
        console.error("ERROR LOGGING MESSAGE:", err);
    }
};

/***************************************************************
 *  END PART 3 — reply **"part 4"**
 ***************************************************************/
/***************************************************************
 *  LoveTextForHer — Backend (Part 4 / 7)
 *  ------------------------------------------------------------
 *  ✔ Customer register/login/logout
 *  ✔ Admin register/login/logout
 *  ✔ JWT middleware for both roles
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

        res.cookie("customer_token", token, {
            httpOnly: true,
            secure: true,
            sameSite: "none",
            path: "/",
            maxAge: 7 * 86400 * 1000 // 7 days
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
 *  AUTH MIDDLEWARE — CUSTOMER
 ***************************************************************/
global.authCustomer = function (req, res, next) {
    try {
        const token = req.cookies.customer_token;

        if (!token)
            return res.status(401).json({ error: "Not logged in" });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (decoded.role !== "customer")
            throw new Error("Role mismatch");

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
 *  AUTH MIDDLEWARE — ADMIN
 ***************************************************************/
global.authAdmin = function (req, res, next) {
    try {
        const token = req.cookies.admin_token;

        if (!token)
            return res.status(401).json({ error: "Not logged in" });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (decoded.role !== "admin")
            throw new Error("Role mismatch");

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
 *  CUSTOMER /me
 ***************************************************************/
app.get("/api/customer/me", authCustomer, async (req, res) => {
    try {
        const q = await pool.query(
            `
            SELECT id, name, email, has_subscription, current_plan
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
 *  END PART 4 — reply **"part 5"**
 ***************************************************************/
/***************************************************************
 *  LoveTextForHer — Backend (Part 5 / 7)
 *  ------------------------------------------------------------
 *  ✔ Recipient list/add/delete
 *  ✔ Subscription limits enforced
 *  ✔ Message logs
 *  ✔ Flower system
 *  ✔ Unsubscribe endpoint
 *  ✔ Admin tools
 ***************************************************************/

/***************************************************************
 *  COUNT RECIPIENTS FOR A CUSTOMER
 ***************************************************************/
async function countRecipients(customerId) {
    const q = await pool.query(
        "SELECT COUNT(*) FROM users WHERE customer_id=$1",
        [customerId]
    );
    return Number(q.rows[0].count);
}

/***************************************************************
 *  GET ALL RECIPIENTS FOR LOGGED-IN CUSTOMER
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
 *  ADD RECIPIENT (LIMITS ENFORCED)
 ***************************************************************/
app.post("/api/customer/recipients", authCustomer, async (req, res) => {
    try {
        const customerQ = await pool.query(
            "SELECT current_plan FROM customers WHERE id=$1",
            [req.user.id]
        );

        if (!customerQ.rows.length)
            return res.status(404).json({ error: "Customer not found" });

        const plan = customerQ.rows[0].current_plan;
        const maxAllowed = getRecipientLimit(plan);
        const currentCount = await countRecipients(req.user.id);

        if (currentCount >= maxAllowed) {
            return res.status(400).json({
                error: "Your subscription plan does not allow additional recipients."
            });
        }

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
        console.error("DELETE RECIPIENT ERROR:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/***************************************************************
 *  MESSAGE LOG (last 5)
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
 *  SEND FLOWER MESSAGE
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

        const unsubscribeURL = `${process.env.BASE_URL}/unsubscribe.html?token=${r.unsubscribe_token}`;
        const flowerMessage =
            `🌸 You received a flower!` +
            (note?.trim() ? ` — ${sanitize(note)}` : "");

        const html = buildLoveEmailHTML(r.name, flowerMessage, unsubscribeURL);

        await sendEmail(
            r.email,
            "You received a flower 🌸",
            html,
            flowerMessage + "\n\nUnsubscribe: " + unsubscribeURL
        );

        await pool.query(
            `
            INSERT INTO message_logs (customer_id, recipient_id, email, message)
            VALUES ($1,$2,$3,$4)
            `,
            [req.user.id, r.id, r.email, flowerMessage]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("FLOWER ERROR:", err);
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
            return res.status(404).send("Invalid unsubscribe link.");

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
 *  ADMIN — VIEW ALL RECIPIENTS
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
 *  ADMIN — DELETE RECIPIENT
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
 *  ADMIN — SEND MESSAGE NOW
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
 *  ✔ Romantic message builder
 *  ✔ Email HTML template
 *  ✔ Resend email sender (+ Brevo fallback)
 *  ✔ Cron scheduler (every 5 minutes)
 *  ✔ Full timezone support
 *  ✔ Only sends when user has valid subscription
 ***************************************************************/


/***************************************************************
 *  PRIMARY MESSAGE BUILDER
 ***************************************************************/
function buildMessage(name, relationship) {
    const base = [
        `Hey ${name}, you’re appreciated more than you know ❤️`,
        `${name}, someone is thinking about you right now 💕`,
        `${name}, you deserve kindness and all the love today 🌸`,
        `${name}, you brighten someone’s entire world ✨`,
        `${name}, you matter more than words can say 💖`
    ];

    const extras = {
        spouse: [
            `Your partner wanted you to know you're their whole world 💍💕`,
            `Your spouse loves you more than words can say ❤️`
        ],
        girlfriend: [
            `Your boyfriend wants you to remember you're his biggest blessing 💖`,
            `You are loved more every single day 💕`
        ],
        boyfriend: [
            `Your girlfriend thinks you're amazing and loves you deeply ❤️`,
            `You are strong, valued, and deeply loved 💙`
        ],
        mom: [
            `Your child wants you to know how much they appreciate you ❤️`,
            `You are the heart and strength of your family 💐`
        ],
        dad: [
            `Your child admires you more than you know 💙`,
            `Your strength inspires your entire family 👨‍👧‍👦`
        ],
        sister: [
            `A sibling who loves you wanted you to smile today 💕`,
            `You’re the best sister anyone could ask for 🎀`
        ],
        brother: [
            `Someone who admires you wanted you to know you're amazing 💙`,
            `Best brother award goes to you 🏆`
        ],
        friend: [
            `A friend who cares about you wanted to brighten your day 😊`,
            `You're the kind of friend everyone wishes they had 💛`
        ]
    };

    let msg = base[Math.floor(Math.random() * base.length)];

    if (extras[relationship]) {
        msg += " " + extras[relationship][Math.floor(Math.random() * extras[relationship].length)];
    }

    return msg;
}
global.buildMessage = buildMessage;


/***************************************************************
 *  EMAIL HTML TEMPLATE
 ***************************************************************/
function buildLoveEmailHTML(name, message, unsubscribeURL) {
    return `
        <div style="font-family:Arial;padding:25px;background:#fff3f8;color:#d6336c;border-radius:14px;">
            <h2 style="margin:0;">A Message For ${name} ❤️</h2>

            <p style="font-size:17px;line-height:1.6;margin-top:15px;">
                ${message}
            </p>

            <br>

            <a href="${unsubscribeURL}" style="color:#777;font-size:13px;text-decoration:none;">
                Unsubscribe from these messages
            </a>
        </div>
    `;
}
global.buildLoveEmailHTML = buildLoveEmailHTML;


/***************************************************************
 *  EMAIL SENDER — Resend (primary) + Brevo SMTP (fallback)
 ***************************************************************/
async function sendEmail(to, subject, html, text) {
    try {
        // Attempt Resend first
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

    // Brevo fallback
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

        console.log("📧 Sent via Brevo SMTP fallback");
        return true;

    } catch (err) {
        console.error("❌ Email send FAILED:", err);
        return false;
    }
}
global.sendEmail = sendEmail;


/***************************************************************
 *  CRON JOB — RUNS EVERY 5 MINUTES
 ***************************************************************/
cron.schedule("*/5 * * * *", async () => {
    console.log("⏰ CRON: Checking message schedules...");

    try {
        const q = await pool.query(`
            SELECT u.*, c.current_plan, c.has_subscription
            FROM users u
            LEFT JOIN customers c ON c.id = u.customer_id
            WHERE u.is_active = true
        `);

        const nowUTC = new Date();

        for (const r of q.rows) {

            // Only send if subscription is valid
            if (!r.has_subscription) continue;

            // Convert current time into recipient's timezone
            const nowUser = new Date(
                nowUTC.toLocaleString("en-US", { timeZone: r.timezone })
            );

            const hour = nowUser.getHours();

            const timingWindows = {
                morning: [6, 12],
                afternoon: [12, 17],
                evening: [17, 21],
                night: [21, 24]
            };

            const [minH, maxH] = timingWindows[r.timings] || [0, 24];

            if (hour < minH || hour >= maxH) continue;
            if (r.next_delivery && new Date(r.next_delivery) > nowUTC) continue;

            // Build the message
            const loveMsg = buildMessage(r.name, r.relationship);

            const unsubscribeURL =
                `${process.env.BASE_URL}/unsubscribe.html?token=${r.unsubscribe_token}`;

            const html = buildLoveEmailHTML(r.name, loveMsg, unsubscribeURL);

            await sendEmail(
                r.email,
                "A Love Message For You ❤️",
                html,
                loveMsg + "\n\nUnsubscribe: " + unsubscribeURL
            );

            // Log message
            await pool.query(
                `
                INSERT INTO message_logs (customer_id, recipient_id, email, message)
                VALUES ($1,$2,$3,$4)
                `,
                [r.customer_id, r.id, r.email, loveMsg]
            );

            // Calculate next scheduled send based on frequency
            let next = new Date(nowUTC);

            switch (r.frequency) {
                case "daily":
                    next.setDate(next.getDate() + 1);
                    break;
                case "every-other-day":
                    next.setDate(next.getDate() + 2);
                    break;
                case "three-times-week":
                    next.setDate(next.getDate() + 2);
                    break;
                case "weekly":
                    next.setDate(next.getDate() + 7);
                    break;
                case "bi-weekly":
                    next.setDate(next.getDate() + 14);
                    break;
                default:
                    next.setDate(next.getDate() + 1);
            }

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
 *  END PART 6 — reply “part 7”
 ***************************************************************/
/***************************************************************
 *  LoveTextForHer — Backend (Part 7 / 7)
 *  ------------------------------------------------------------
 *  ✔ Cart system
 *  ✔ Merch checkout (Stripe one-time)
 *  ✔ Subscription checkout (FINAL FIXED VERSION)
 *  ✔ Billing portal
 *  ✔ Global price map connected
 *  ✔ React-compatible return URLs
 *  ✔ Server start
 ***************************************************************/


/***************************************************************
 *  GET CUSTOMER CART
 ***************************************************************/
app.get("/api/cart", authCustomer, async (req, res) => {
    try {
        const q = await pool.query(
            "SELECT items FROM carts WHERE customer_id=$1",
            [req.user.id]
        );

        return res.json({
            items: q.rows.length ? q.rows[0].items : []
        });

    } catch (err) {
        console.error("❌ CART LOAD ERROR:", err);
        return res.status(500).json({ error: "Unable to load cart" });
    }
});


/***************************************************************
 *  ADD ITEM TO CART
 ***************************************************************/
app.post("/api/cart/add", authCustomer, async (req, res) => {
    try {
        let { productId, name, price } = req.body;

        if (!productId || !name || !price)
            return res.status(400).json({ error: "Invalid item" });

        const q = await pool.query(
            "SELECT items FROM carts WHERE customer_id=$1",
            [req.user.id]
        );

        const items = q.rows.length ? q.rows[0].items : [];
        items.push({ productId, name, price });

        await pool.query(
            `INSERT INTO carts (customer_id, items)
             VALUES ($1, $2)
             ON CONFLICT (customer_id)
             DO UPDATE SET items=$2`,
            [req.user.id, JSON.stringify(items)]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("❌ CART ADD ERROR:", err);
        return res.status(500).json({ error: "Unable to add item" });
    }
});


/***************************************************************
 *  REMOVE ITEM FROM CART
 ***************************************************************/
app.post("/api/cart/remove", authCustomer, async (req, res) => {
    try {
        let { productId } = req.body;

        const q = await pool.query(
            "SELECT items FROM carts WHERE customer_id=$1",
            [req.user.id]
        );

        if (!q.rows.length)
            return res.json({ success: true });

        const items = q.rows[0].items.filter(i => i.productId !== productId);

        await pool.query(
            "UPDATE carts SET items=$1 WHERE customer_id=$2",
            [JSON.stringify(items), req.user.id]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("❌ CART REMOVE ERROR:", err);
        return res.status(500).json({ error: "Unable to remove item" });
    }
});


/***************************************************************
 *  MERCH CHECKOUT — ONE-TIME
 ***************************************************************/
app.post("/api/stripe/merch-checkout", authCustomer, async (req, res) => {
    try {
        const { items } = req.body;

        if (!items || !Array.isArray(items) || items.length === 0)
            return res.status(400).json({ error: "No items provided" });

        const lineItems = items.map(item => ({
            price_data: {
                currency: "usd",
                product_data: { name: item.name },
                unit_amount: Math.round(item.price * 100)
            },
            quantity: 1
        }));

        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            line_items: lineItems,
            success_url: `${process.env.FRONTEND_URL}/success.html`,
            cancel_url: `${process.env.FRONTEND_URL}/cart.html`,
            metadata: { customer_id: req.user.id }
        });

        // Clear cart
        await pool.query(
            "UPDATE carts SET items='[]' WHERE customer_id=$1",
            [req.user.id]
        );

        return res.json({ url: session.url });

    } catch (err) {
        console.error("❌ MERCH CHECKOUT ERROR:", err);
        return res.status(500).json({ error: "Unable to start checkout" });
    }
});


/***************************************************************
 *  SUBSCRIPTION CHECKOUT — **FINAL FIXED VERSION**
 ***************************************************************/
app.post("/api/stripe/checkout", authCustomer, async (req, res) => {
    try {
        const { productId } = req.body;

        // Price map generated in Part 1
        const priceId = PRICE_MAP[productId];
        if (!priceId)
            return res.status(400).json({ error: "Invalid plan" });

        // Load customer
        const q = await pool.query(
            "SELECT * FROM customers WHERE id=$1",
            [req.user.id]
        );

        const customer = q.rows[0];

        let stripeCustomerId = customer.stripe_customer_id;

        // Create Stripe customer if missing
        if (!stripeCustomerId) {
            const sc = await stripe.customers.create({
                email: customer.email,
                metadata: { customer_id: customer.id }
            });

            stripeCustomerId = sc.id;

            await pool.query(
                "UPDATE customers SET stripe_customer_id=$1 WHERE id=$2",
                [stripeCustomerId, customer.id]
            );
        }

        // Create checkout session (subscription)
        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            customer: stripeCustomerId,
            line_items: [
                {
                    price: priceId,
                    quantity: 1
                }
            ],
            success_url: `${process.env.FRONTEND_URL}/dashboard.html`,
            cancel_url: `${process.env.FRONTEND_URL}/products.html`,
            metadata: { customer_id: customer.id }
        });

        return res.json({ url: session.url });

    } catch (err) {
        console.error("❌ SUBSCRIPTION CHECKOUT ERROR:", err);
        return res.status(500).json({ error: "Unable to create subscription" });
    }
});


/***************************************************************
 *  BILLING PORTAL
 ***************************************************************/
app.get("/api/customer/subscription/portal", authCustomer, async (req, res) => {
    try {
        const q = await pool.query(
            "SELECT stripe_customer_id FROM customers WHERE id=$1",
            [req.user.id]
        );

        if (!q.rows.length || !q.rows[0].stripe_customer_id)
            return res.status(400).json({ error: "No Stripe customer found" });

        const portal = await stripe.billingPortal.sessions.create({
            customer: q.rows[0].stripe_customer_id,
            return_url: `${process.env.FRONTEND_URL}/dashboard.html`
        });

        return res.json({ url: portal.url });

    } catch (err) {
        console.error("❌ BILLING PORTAL ERROR:", err);
        return res.status(500).json({ error: "Billing portal error" });
    }
});


/***************************************************************
 *  FALLBACK — SERVE FRONTEND
 ***************************************************************/
app.get("*", (req, res) => {
    try {
        return res.sendFile(path.join(__dirname, "public", "index.html"));
    } catch (err) {
        return res.status(404).send("Not Found");
    }
});


/***************************************************************
 *  START SERVER
 ***************************************************************/
app.listen(PORT, () => {
    console.log(`🚀 LoveTextForHer Backend Running on Port ${PORT}`);
});
