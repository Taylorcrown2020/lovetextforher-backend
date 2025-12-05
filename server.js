process.env.TZ = "UTC";

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const cron = require("node-cron");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

/* =====================================================================================
   STRIPE INITIALIZATION
===================================================================================== */

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
    stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    console.log("⚡ Stripe Loaded");
} else {
    console.log("⚠️ Stripe Disabled — Missing STRIPE_SECRET_KEY");
}

const STRIPE_PRICES = {
    "love-basic": process.env.STRIPE_BASIC_PRICE_ID,
    "love-plus": process.env.STRIPE_PLUS_PRICE_ID,
    "free-trial": process.env.STRIPE_FREETRIAL_PRICE_ID
};

/* =====================================================================================
   MIDDLEWARE
===================================================================================== */

app.use(express.static(path.join(__dirname, "public")));

app.use(
    cors({
        origin: true,
        credentials: true
    })
);

app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

/* =====================================================================================
   DATABASE CONNECTION
===================================================================================== */

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
});

pool.query("SELECT NOW()")
    .then(() => console.log("✅ DB CONNECTED"))
    .catch(err => console.error("❌ DB ERROR:", err));

/* =====================================================================================
   EMAIL (RESEND)
===================================================================================== */

const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendEmail(to, subject, html, text = "") {
    try {
        const data = await resend.emails.send({
            from: process.env.FROM_EMAIL,
            to,
            subject,
            html,
            text: text || html.replace(/<[^>]*>/g, "")
        });
        console.log("📨 Email sent:", data?.id);
        return true;
    } catch (err) {
        console.error("❌ Email send error:", err);
        return false;
    }
}

/* =====================================================================================
   MESSAGE TEMPLATE SYSTEM
===================================================================================== */

const MESSAGE_TEMPLATES = {
    spouse: [
        "Hey {name}, your partner loves you deeply ❤️",
        "{name}, you're cherished every single day 💍",
        "Someone married to you is thinking of you 💕"
    ],
    girlfriend: [
        "{name}, you're loved more every day 💖",
        "Someone can't stop thinking about you 🌹",
        "A sweet reminder that you're adored, {name} ❤️"
    ],
    boyfriend: [
        "Hey {name}, someone is proud of you 💙",
        "You're appreciated more than you know 💌",
        "Someone loves you like crazy, {name} 😘"
    ],
    mom: [
        "{name}, you're the heart of the family ❤️",
        "You mean more than words can say 🌷",
        "A little extra love for your day 💞"
    ],
    dad: [
        "{name}, you're stronger than you realize 💙",
        "Someone appreciates everything you do 💪",
        "A reminder you're loved, {name} 💌"
    ],
    sister: [
        "{name}, you're an amazing sister 💕",
        "Someone is grateful for you ✨",
        "A sweet reminder you're loved 💖"
    ],
    brother: [
        "{name}, someone is proud of you ❤️",
        "You're appreciated more than you know 💙",
        "A reminder you matter 💌"
    ],
    friend: [
        "Hey {name}, you're a great friend 😊",
        "Someone is thinking about you 💛",
        "A little love coming your way ✨"
    ],
    default: [
        "Hey {name}, someone cares about you ❤️",
        "A message to brighten your day ✨",
        "Sending a little love your way 💌"
    ]
};

function getMessage(name, relationship) {
    const set = MESSAGE_TEMPLATES[relationship?.toLowerCase()] || MESSAGE_TEMPLATES.default;
    const template = set[Math.floor(Math.random() * set.length)];
    return template.replace("{name}", name);
}

function buildLoveEmailHTML(name, msg, unsubscribeURL) {
    return `
        <div style="font-family:Arial, sans-serif; padding:20px;">
            <h2 style="color:#d6336c;">Hello ${name} ❤️</h2>
            <p style="font-size:16px;">${msg}</p>
            <br>
            <a href="${unsubscribeURL}" style="color:#999; font-size:12px;">Unsubscribe</a>
        </div>
    `;
}

/* =====================================================================================
   AUTH MIDDLEWARE — FIXED FOR RENDER
===================================================================================== */

function authCustomer(req, res, next) {
    try {
        const token = req.cookies.customer_token;
        if (!token) return res.status(401).json({ error: "Not logged in" });

        const user = jwt.verify(token, process.env.JWT_SECRET);

        if (user.role !== "customer") throw new Error();

        req.user = user;
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

function authAdmin(req, res, next) {
    try {
        const token = req.cookies.admin_token;
        if (!token) return res.status(401).json({ error: "Not logged in" });

        const admin = jwt.verify(token, process.env.JWT_SECRET);
        if (admin.role !== "admin") throw new Error();

        req.admin = admin;
        next();
    } catch (err) {
        res.clearCookie("admin_token", {
            httpOnly: true,
            secure: true,
            sameSite: "none",
            path: "/"
        });
        return res.status(401).json({ error: "Invalid admin session" });
    }
}

/* =====================================================================================
   ADMIN LOGIN + SEEDING
===================================================================================== */

app.post("/api/admin/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        const q = await pool.query(
            "SELECT * FROM admins WHERE email=$1",
            [email]
        );

        if (!q.rows.length)
            return res.status(400).json({ error: "Invalid credentials" });

        const admin = q.rows[0];

        const match = await bcrypt.compare(password, admin.password_hash);
        if (!match)
            return res.status(400).json({ error: "Invalid credentials" });

        const token = jwt.sign(
            { id: admin.id, email: admin.email, role: "admin" },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.cookie("admin_token", token, {
            httpOnly: true,
            secure: true,
            sameSite: "none",
            path: "/",
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.json({ success: true });

    } catch (err) {
        console.error("ADMIN LOGIN ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

async function seedAdmin() {
    const q = await pool.query("SELECT id FROM admins LIMIT 1");

    if (q.rows.length === 0) {
        const hash = await bcrypt.hash("Admin123!", 10);
        await pool.query(
            "INSERT INTO admins (email, password_hash) VALUES ($1,$2)",
            ["admin@lovetextforher.com", hash]
        );
        console.log("🌟 Default admin created");
    }
}
seedAdmin();
/* =====================================================================================
   ADMIN API ROUTES
===================================================================================== */

app.get("/api/admin/me", authAdmin, (req, res) => {
    res.json({
        admin: {
            id: req.admin.id,
            email: req.admin.email,
            role: "admin"
        }
    });
});

app.get("/api/admin/recipients", authAdmin, async (req, res) => {
    try {
        const q = await pool.query(`
            SELECT id, customer_id, email, name, relationship, frequency, timings,
                   timezone, next_delivery, last_sent, is_active
            FROM users
            ORDER BY id DESC
        `);
        res.json(q.rows);
    } catch (err) {
        console.error("ADMIN RECIPIENTS ERROR:", err);
        res.status(500).json({ error: "Server error loading recipients" });
    }
});

app.post("/api/admin/send-now/:id", authAdmin, async (req, res) => {
    try {
        const id = req.params.id;

        const q = await pool.query("SELECT * FROM users WHERE id=$1", [id]);
        if (!q.rows.length)
            return res.status(404).json({ error: "Recipient not found" });

        const u = q.rows[0];

        const unsubscribeURL = `${process.env.BASE_URL}/unsubscribe.html?token=${u.unsubscribe_token}`;

        const msg = getMessage(u.name, u.relationship);
        const html = buildLoveEmailHTML(u.name, msg, unsubscribeURL);

        await sendEmail(
            u.email,
            "Your Love Message ❤️",
            html,
            msg + "\n\nUnsubscribe: " + unsubscribeURL
        );

        await logMessage(u.customer_id, u.id, u.email, msg);

        res.json({ success: true });

    } catch (err) {
        console.error("ADMIN SEND-NOW ERROR:", err);
        res.status(500).json({ error: "Failed to send now" });
    }
});

app.post("/api/admin/logout", (req, res) => {
    res.clearCookie("admin_token", {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/"
    });
    res.json({ success: true });
});

app.delete("/api/admin/recipients/:id", authAdmin, async (req, res) => {
    try {
        await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error("ADMIN DELETE RECIPIENT ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* =====================================================================================
   ADMIN: CUSTOMERS + KPIs
===================================================================================== */

app.get("/api/admin/customers", authAdmin, async (req, res) => {
    try {
        const q = await pool.query(`
            SELECT id, email, name, has_subscription, current_plan,
                   stripe_customer_id, stripe_subscription_id,
                   subscription_end,
                   trial_active, trial_end, created_at
            FROM customers
            ORDER BY id DESC
        `);
        res.json(q.rows);
    } catch (err) {
        console.error("ADMIN CUSTOMERS ERROR:", err);
        res.status(500).json({ error: "Server error loading customers" });
    }
});

app.delete("/api/admin/customer/:id", authAdmin, async (req, res) => {
    try {
        const id = req.params.id;

        await pool.query("DELETE FROM users WHERE customer_id=$1", [id]);
        const q = await pool.query("DELETE FROM customers WHERE id=$1", [id]);

        if (q.rowCount === 0)
            return res.status(404).json({ error: "Customer not found" });

        res.json({ success: true });
    } catch (err) {
        console.error("ADMIN DELETE CUSTOMER ERROR:", err);
        res.status(500).json({ error: "Server error deleting customer" });
    }
});

app.get("/api/admin/kpis", authAdmin, async (req, res) => {
    try {
        const totalCustomers = await pool.query("SELECT COUNT(*) FROM customers");
        const activeSubs = await pool.query("SELECT COUNT(*) FROM customers WHERE has_subscription = true");
        const trials = await pool.query("SELECT COUNT(*) FROM customers WHERE trial_active = true");
        const totalRecipients = await pool.query("SELECT COUNT(*) FROM users");
        const totalMessages = await pool.query("SELECT COUNT(*) FROM message_logs");

        let newCustomersToday = 0;
        let newRecipientsToday = 0;

        try {
            const nc = await pool.query(`
                SELECT COUNT(*) FROM customers WHERE created_at::date = CURRENT_DATE
            `);
            newCustomersToday = Number(nc.rows[0].count);
        } catch {}

        try {
            const nr = await pool.query(`
                SELECT COUNT(*) FROM users WHERE created_at::date = CURRENT_DATE
            `);
            newRecipientsToday = Number(nr.rows[0].count);
        } catch {}

        res.json({
            total_customers: Number(totalCustomers.rows[0].count),
            active_subscriptions: Number(activeSubs.rows[0].count),
            trials_active: Number(trials.rows[0].count),
            total_recipients: Number(totalRecipients.rows[0].count),
            total_messages_sent: Number(totalMessages.rows[0].count),
            new_customers_today: newCustomersToday,
            new_recipients_today: newRecipientsToday
        });

    } catch (err) {
        console.error("ADMIN KPI ERROR:", err);
        res.status(500).json({ error: "Failed to load KPIs" });
    }
});

/* =====================================================================================
   CUSTOMER REGISTER / LOGIN / LOGOUT
===================================================================================== */

app.post("/api/customer/register", async (req, res) => {
    try {
        const { email, password, name } = req.body;

        const exists = await pool.query(
            "SELECT id FROM customers WHERE email=$1",
            [email]
        );

        if (exists.rows.length > 0)
            return res.status(400).json({ error: "Email already exists" });

        const hash = await bcrypt.hash(password, 10);

        await pool.query(
            `INSERT INTO customers 
                (email, password_hash, name, has_subscription, current_plan)
             VALUES ($1,$2,$3,false,'none')`,
            [email, hash, name]
        );

        res.json({ success: true });

    } catch (err) {
        console.error("REGISTER ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

app.post("/api/customer/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        const q = await pool.query(
            "SELECT * FROM customers WHERE email=$1",
            [email]
        );

        if (!q.rows.length)
            return res.status(400).json({ error: "Invalid credentials" });

        const user = q.rows[0];

        const match = await bcrypt.compare(password, user.password_hash);
        if (!match)
            return res.status(400).json({ error: "Invalid credentials" });

        const token = jwt.sign(
            { id: user.id, email: user.email, role: "customer" },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.cookie("customer_token", token, {
            httpOnly: true,
            secure: true,
            sameSite: "none",
            path: "/",
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.json({ success: true });

    } catch (err) {
        console.error("LOGIN ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

app.post("/api/customer/logout", (req, res) => {
    res.clearCookie("customer_token", {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/"
    });
    res.json({ success: true });
});

/* =====================================================================================
   SUBSCRIPTION STATUS
===================================================================================== */

app.get("/api/customer/subscription", authCustomer, async (req, res) => {
    try {
        const q = await pool.query(`
            SELECT has_subscription, current_plan, trial_active, trial_end,
                   stripe_subscription_id, subscription_end
            FROM customers
            WHERE id=$1
        `, [req.user.id]);

        if (!q.rows.length)
            return res.status(404).json({ error: "User not found" });

        const row = q.rows[0];

        res.json({
            subscribed: row.has_subscription,
            plan: row.current_plan,
            is_trial: row.trial_active,
            trial_end: row.trial_end,
            subscription_end: row.subscription_end,
            stripe_subscription_id: row.stripe_subscription_id
        });

    } catch (err) {
        console.error("SUB STATUS ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* =====================================================================================
   STRIPE — ENSURE CUSTOMER EXISTS
===================================================================================== */

async function ensureStripeCustomer(customer) {
    if (customer.stripe_customer_id) return customer.stripe_customer_id;

    const sc = await stripe.customers.create({ email: customer.email });

    await pool.query(
        "UPDATE customers SET stripe_customer_id=$1 WHERE id=$2",
        [sc.id, customer.id]
    );

    return sc.id;
}

/* =====================================================================================
   STRIPE CHECKOUT — TRIAL, UPGRADE, DOWNGRADE
===================================================================================== */

app.post("/api/stripe/checkout", authCustomer, async (req, res) => {
    const { productId } = req.body;

    try {
        const q = await pool.query("SELECT * FROM customers WHERE id=$1", [req.user.id]);
        const customer = q.rows[0];

        if (!customer)
            return res.status(404).json({ error: "User not found" });

        // ❌ Trial can only be first subscription
        if (productId === "free-trial" && customer.has_subscription) {
            return res.status(400).json({
                error: "Trial is only available as your first subscription."
            });
        }

        const stripeCustomerId = await ensureStripeCustomer(customer);

        const priceId = STRIPE_PRICES[productId];
        if (!priceId)
            return res.status(400).json({ error: "Invalid product" });

        const existingSub = customer.stripe_subscription_id;

        /* ------------------------------------------------------------------
           MODIFY EXISTING SUBSCRIPTION
        ------------------------------------------------------------------ */
        if (existingSub) {
            const subscription = await stripe.subscriptions.retrieve(existingSub);

            const itemId = subscription.items.data[0].id;

            await stripe.subscriptions.update(existingSub, {
                cancel_at_period_end: false,
                proration_behavior: "always_invoice",
                items: [{ id: itemId, price: priceId }]
            });

            const normalized =
                productId === "love-basic" ? "basic" :
                productId === "love-plus" ? "plus" :
                productId === "free-trial" ? "trial" :
                "none";

            await pool.query(`
                UPDATE customers SET
                    current_plan=$1,
                    has_subscription=true,
                    trial_active=$2,
                    trial_end=$3,
                    subscription_end=NULL
                WHERE id=$4
            `, [
                normalized,
                normalized === "trial",
                normalized === "trial" ? new Date(Date.now() + 3*86400*1000) : null,
                req.user.id
            ]);

            return res.json({ url: "/dashboard.html" });
        }

        /* ------------------------------------------------------------------
           FIRST-TIME SUBSCRIPTION
        ------------------------------------------------------------------ */

        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            customer: stripeCustomerId,
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${process.env.BASE_URL}/dashboard.html`,
            cancel_url: `${process.env.BASE_URL}/products.html`,
            subscription_data: {
                metadata: {
                    customer_id: req.user.id,
                    plan: productId
                }
            },
            metadata: {
                customer_id: req.user.id,
                plan: productId
            }
        });

        res.json({ url: session.url });

    } catch (err) {
        console.error("STRIPE CHECKOUT ERROR:", err);
        res.status(500).json({ error: "Checkout error" });
    }
});

/* =====================================================================================
   BILLING PORTAL
===================================================================================== */

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
            return_url: `${process.env.BASE_URL}/dashboard.html`
        });

        res.json({ url: portal.url });

    } catch (err) {
        console.error("BILLING PORTAL ERROR:", err);
        res.status(500).json({ error: "Failed to open portal" });
    }
});

/* =====================================================================================
   STRIPE WEBHOOK (FULLY FIXED)
===================================================================================== */

app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
        if (!stripe)
            return res.status(500).send("Stripe not configured");

        const sig = req.headers["stripe-signature"];
        let event;

        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                sig,
                process.env.STRIPE_WEBHOOK_SECRET
            );
        } catch (err) {
            console.error("❌ Webhook signature error:", err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        console.log("⚡ STRIPE EVENT:", event.type);

        try {
            /* ================================================================
               CHECKOUT SUCCESS
            ================================================================ */
            if (event.type === "checkout.session.completed") {
                const session = event.data.object;

                const subscriptionId = session.subscription;
                const subscription = await stripe.subscriptions.retrieve(subscriptionId);

                const customerId = subscription.metadata.customer_id;
                const plan = subscription.metadata.plan;
                const stripeCustomerId = subscription.customer;

                const normalized =
                    plan === "free-trial" ? "trial" :
                    plan === "love-basic" ? "basic" :
                    plan === "love-plus"  ? "plus" :
                    "none";

                await pool.query(`
                    UPDATE customers SET
                        stripe_customer_id=$1,
                        stripe_subscription_id=$2,
                        has_subscription=true,
                        current_plan=$3,
                        trial_active=$4,
                        trial_end=$5,
                        subscription_end=NULL
                    WHERE id=$6
                `, [
                    stripeCustomerId,
                    subscriptionId,
                    normalized,
                    normalized === "trial",
                    normalized === "trial"
                        ? new Date(Date.now() + 3*86400*1000)
                        : null,
                    customerId
                ]);

                return res.json({ received: true });
            }

            /* ================================================================
               SUB UPDATED (UPGRADE / DOWNGRADE)
            ================================================================ */
            if (event.type === "customer.subscription.updated") {
                const sub = event.data.object;
                const stripeCustomerId = sub.customer;

                const planId = sub.items.data[0].price.id;

                let normalized =
                    planId === process.env.STRIPE_BASIC_PRICE_ID ? "basic" :
                    planId === process.env.STRIPE_PLUS_PRICE_ID  ? "plus" :
                    planId === process.env.STRIPE_FREETRIAL_PRICE_ID ? "trial" :
                    "none";

                await pool.query(`
                    UPDATE customers SET
                        stripe_subscription_id=$1,
                        current_plan=$2,
                        has_subscription=true,
                        trial_active=$3,
                        trial_end=$4,
                        subscription_end=NULL
                    WHERE stripe_customer_id=$5
                `, [
                    sub.id,
                    normalized,
                    normalized === "trial",
                    normalized === "trial"
                        ? new Date(Date.now() + 3*86400*1000)
                        : null,
                    stripeCustomerId
                ]);

                return res.json({ received: true });
            }

            /* ================================================================
               SUB CANCELLED (ACCESS UNTIL PERIOD END)
            ================================================================ */
            if (event.type === "customer.subscription.deleted") {
                const sub = event.data.object;
                const stripeCustomerId = sub.customer;

                const periodEnd = new Date(sub.current_period_end * 1000);

                await pool.query(`
                    UPDATE customers SET
                        has_subscription=true,
                        subscription_end=$1,
                        stripe_subscription_id=$2
                    WHERE stripe_customer_id=$3
                `, [periodEnd, sub.id, stripeCustomerId]);

                return res.json({ received: true });
            }

            res.json({ received: true });

        } catch (err) {
            console.error("❌ Webhook processing error:", err);
            res.status(500).send("Webhook processing error");
        }
    }
);
/* =====================================================================================
   RECIPIENT LIMITS
===================================================================================== */

function getRecipientLimit(plan) {
    if (plan === "basic") return 3;
    if (plan === "plus") return Infinity;
    if (plan === "trial") return Infinity;
    return 0;
}

async function canAddRecipient(customerId) {
    const q = await pool.query(
        "SELECT current_plan FROM customers WHERE id=$1",
        [customerId]
    );

    if (!q.rows.length) return false;

    const plan = q.rows[0].current_plan;
    const limit = getRecipientLimit(plan);

    const countQ = await pool.query(
        "SELECT COUNT(*) FROM users WHERE customer_id=$1",
        [customerId]
    );

    const count = Number(countQ.rows[0].count);
    return count < limit;
}

/* =====================================================================================
   RECIPIENT LIST (CUSTOMER)
===================================================================================== */

app.get("/api/customer/recipients", authCustomer, async (req, res) => {
    try {
        const q = await pool.query(`
            SELECT id, email, name, relationship, frequency, timings,
                   timezone, next_delivery, last_sent, is_active
            FROM users
            WHERE customer_id=$1
            ORDER BY id DESC
        `, [req.user.id]);

        res.json(q.rows);

    } catch (err) {
        console.error("RECIPIENT LOAD ERROR:", err);
        res.status(500).json({ error: "Server error loading recipients" });
    }
});

/* =====================================================================================
   ADD RECIPIENT
===================================================================================== */

app.post("/api/customer/recipients", authCustomer, async (req, res) => {
    try {
        const allowed = await canAddRecipient(req.user.id);
        if (!allowed) {
            return res.status(400).json({
                error: "Your subscription plan does not allow more recipients."
            });
        }

        const {
            name,
            email,
            relationship,
            frequency,
            timings,
            timezone
        } = req.body;

        const unsubscribeToken = crypto.randomBytes(16).toString("hex");

        await pool.query(`
            INSERT INTO users (
                email, customer_id, name, relationship, frequency,
                timings, timezone, unsubscribe_token, is_active,
                next_delivery
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,NOW())
        `, [
            email,
            req.user.id,
            name,
            relationship,
            frequency,
            timings,
            timezone,
            unsubscribeToken
        ]);

        res.json({ success: true });

    } catch (err) {
        console.error("RECIPIENT ADD ERROR:", err);
        res.status(500).json({ error: "Server error adding recipient" });
    }
});

/* =====================================================================================
   DELETE RECIPIENT
===================================================================================== */

app.delete("/api/customer/recipients/:id", authCustomer, async (req, res) => {
    try {
        await pool.query(`
            DELETE FROM users
            WHERE id=$1 AND customer_id=$2
        `, [req.params.id, req.user.id]);

        res.json({ success: true });

    } catch (err) {
        console.error("RECIPIENT DELETE ERROR:", err);
        res.status(500).json({ error: "Server error deleting recipient" });
    }
});

/* =====================================================================================
   MESSAGE LOG (RECENT 5)
===================================================================================== */

app.get("/api/message-log/:recipientId", authCustomer, async (req, res) => {
    try {
        const rid = req.params.recipientId;

        const logs = await pool.query(`
            SELECT message AS message_text, sent_at
            FROM message_logs
            WHERE customer_id=$1 AND recipient_id=$2
            ORDER BY sent_at DESC
            LIMIT 5
        `, [req.user.id, rid]);

        res.json({
            success: true,
            messages: logs.rows
        });

    } catch (err) {
        console.error("MESSAGE LOG ERROR:", err);
        res.status(500).json({ error: "Error fetching logs" });
    }
});

/* =====================================================================================
   SEND FLOWERS (MANUAL CUSTOM MESSAGE)
===================================================================================== */

app.post("/api/customer/send-flowers/:recipientId", authCustomer, async (req, res) => {
    try {
        const { note } = req.body;
        const rid = req.params.recipientId;

        const lookup = await pool.query(
            "SELECT email, name FROM users WHERE id=$1 AND customer_id=$2",
            [rid, req.user.id]
        );

        if (!lookup.rows.length)
            return res.status(404).json({ error: "Recipient not found" });

        const r = lookup.rows[0];

        const msg = `💐 Flower Delivery: ${note || "You were sent flowers!"}`;

        await pool.query(`
            INSERT INTO message_logs (customer_id, recipient_id, email, message)
            VALUES ($1,$2,$3,$4)
        `, [req.user.id, rid, r.email, msg]);

        res.json({ success: true });

    } catch (err) {
        console.error("FLOWER SEND ERROR:", err);
        res.status(500).json({ error: "Error sending flowers" });
    }
});

/* =====================================================================================
   NEXT DELIVERY TIME CALCULATOR
===================================================================================== */

function calculateNextDelivery(freq, timing) {
    const now = new Date();
    const next = new Date(now);

    if (timing === "morning") next.setHours(9, 0, 0);
    if (timing === "afternoon") next.setHours(13, 0, 0);
    if (timing === "evening") next.setHours(18, 0, 0);
    if (timing === "night") next.setHours(22, 0, 0);

    switch (freq) {
        case "daily":
            next.setDate(now.getDate() + 1);
            break;
        case "every-other-day":
            next.setDate(now.getDate() + 2);
            break;
        case "three-times-week":
            next.setDate(now.getDate() + 2);
            break;
        case "weekly":
            next.setDate(now.getDate() + 7);
            break;
        case "bi-weekly":
            next.setDate(now.getDate() + 14);
            break;
    }

    return next;
}

/* =====================================================================================
   CRON JOB — SEND AUTOMATED LOVE MESSAGES (EVERY MINUTE)
===================================================================================== */

cron.schedule("* * * * *", async () => {
    console.log("⏱ CRON: scanning for messages to send…");

    const client = await pool.connect();

    try {
        const now = new Date();

        const due = await client.query(`
            SELECT *
            FROM users
            WHERE is_active=true
              AND next_delivery <= $1
        `, [now]);

        for (const u of due.rows) {
            const unsubscribeURL = `${process.env.BASE_URL}/unsubscribe.html?token=${u.unsubscribe_token}`;

            const msg = getMessage(u.name, u.relationship);
            const html = buildLoveEmailHTML(u.name, msg, unsubscribeURL);

            await sendEmail(
                u.email,
                "Your Love Message ❤️",
                html,
                msg + "\nUnsubscribe: " + unsubscribeURL
            );

            await logMessage(u.customer_id, u.id, u.email, msg);

            const next = calculateNextDelivery(u.frequency, u.timings);

            await client.query(`
                UPDATE users
                SET next_delivery=$1, last_sent=NOW()
                WHERE id=$2
            `, [next, u.id]);
        }

    } catch (err) {
        console.error("❌ CRON ERROR:", err);
    } finally {
        client.release();
    }
});

/* =====================================================================================
   LOG MESSAGE
===================================================================================== */

async function logMessage(customerId, recipientId, email, message) {
    try {
        await pool.query(`
            INSERT INTO message_logs (customer_id, recipient_id, email, message)
            VALUES ($1, $2, $3, $4)
        `, [customerId, recipientId, email, message]);
    } catch (err) {
        console.error("LOG MESSAGE ERROR:", err);
    }
}

/* =====================================================================================
   CART — GET ITEMS
===================================================================================== */

app.get("/api/cart", authCustomer, async (req, res) => {
    try {
        const q = await pool.query(
            "SELECT items FROM carts WHERE customer_id=$1",
            [req.user.id]
        );

        if (!q.rows.length)
            return res.json({ items: [] });

        res.json({ items: q.rows[0].items || [] });

    } catch (err) {
        console.error("CART LOAD ERROR:", err);
        res.status(500).json({ error: "Server error loading cart" });
    }
});

/* =====================================================================================
   CART — ADD
===================================================================================== */

app.post("/api/cart/add", authCustomer, async (req, res) => {
    try {
        const { productId } = req.body;

        const q = await pool.query(
            "SELECT items FROM carts WHERE customer_id=$1",
            [req.user.id]
        );

        const items = q.rows.length ? q.rows[0].items : [];

        items.push({ productId });

        await pool.query(`
            INSERT INTO carts (customer_id, items)
            VALUES ($1,$2)
            ON CONFLICT (customer_id)
            DO UPDATE SET items=$2
        `, [req.user.id, JSON.stringify(items)]);

        res.json({ success: true });

    } catch (err) {
        console.error("CART ADD ERROR:", err);
        res.status(500).json({ error: "Server error adding to cart" });
    }
});

/* =====================================================================================
   CART — REMOVE
===================================================================================== */

app.post("/api/cart/remove", authCustomer, async (req, res) => {
    try {
        const { productId } = req.body;

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

        res.json({ success: true });

    } catch (err) {
        console.error("CART REMOVE ERROR:", err);
        res.status(500).json({ error: "Server error removing from cart" });
    }
});

/* =====================================================================================
   MERCH CHECKOUT (ONE-TIME)
===================================================================================== */

app.post("/api/stripe/merch-checkout", authCustomer, async (req, res) => {
    try {
        if (!stripe) return res.status(500).json({ error: "Stripe not configured" });

        const { items } = req.body;
        if (!items || items.length === 0)
            return res.status(400).json({ error: "No items provided" });

        const lineItems = items.map(i => ({
            price_data: {
                currency: "usd",
                product_data: { name: i.name },
                unit_amount: Math.round(i.price * 100)
            },
            quantity: 1
        }));

        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            line_items: lineItems,
            success_url: `${process.env.BASE_URL}/success.html`,
            cancel_url: `${process.env.BASE_URL}/cart.html`,
            metadata: { customer_id: req.user.id }
        });

        await pool.query(
            "UPDATE carts SET items='[]' WHERE customer_id=$1",
            [req.user.id]
        );

        res.json({ url: session.url });

    } catch (err) {
        console.error("❌ MERCH CHECKOUT ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* =====================================================================================
   START SERVER
===================================================================================== */

app.listen(PORT, () => {
    console.log(`🚀 LoveTextForHer Backend Running on Port ${PORT}`);
});