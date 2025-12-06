/***************************************************************
 *  LoveTextForHer — CLEAN BACKEND (PART 1 OF 7)
 ***************************************************************/

process.env.TZ = "UTC";
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const cookieParser = require("cookie-parser");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const cron = require("node-cron");
const { Resend } = require("resend");

const app = express();
const PORT = process.env.PORT || 3000;

/***************************************************************
 *  ✔ FINAL STRIPE WEBHOOK — THE ONLY ONE
 *  MUST BE ABOVE express.json()
 ***************************************************************/
/***************************************************************
 *  STRIPE WEBHOOK — RAW BODY MUST BE PARSED FIRST
 ***************************************************************/
app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
        const sig = req.headers["stripe-signature"];

        let event;
        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                sig,
                process.env.STRIPE_WEBHOOK_SECRET
            );
        } catch (err) {
            console.error("❌ Stripe Webhook Signature Error:", err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        const db = pool;
        const type = event.type;
        const obj = event.data.object;

        console.log(`⚡ STRIPE WEBHOOK: ${type}`);

        try {
            switch (type) {

                /**********************************************
                 *  CHECKOUT COMPLETED (NEW TRIAL OR SUB)
                 **********************************************/
                case "checkout.session.completed": {
                    const customerId = obj.customer;
                    const subscriptionId = obj.subscription;

                    if (!subscriptionId) break;

                    // Retrieve subscription to check plan
                    const sub = await stripe.subscriptions.retrieve(subscriptionId);
                    const priceId = sub.items.data[0].price.id;

                    let plan = "none";
                    if (priceId === process.env.STRIPE_BASIC_PRICE_ID) plan = "basic";
                    if (priceId === process.env.STRIPE_PLUS_PRICE_ID) plan = "plus";
                    if (priceId === process.env.STRIPE_FREETRIAL_PRICE_ID) plan = "trial";

                    await db.query(`
                        UPDATE customers
                        SET 
                            has_subscription = true,
                            current_plan = $1,
                            stripe_subscription_id = $2,
                            stripe_customer_id = $3,
                            trial_active = ($1 = 'trial'),
                            trial_end = ($1 = 'trial')::boolean * to_timestamp($4),
                            subscription_end = NULL
                        WHERE email = (SELECT email FROM customers WHERE stripe_customer_id IS NULL OR stripe_customer_id=$3 LIMIT 1)
                    `, [
                        plan,
                        subscriptionId,
                        customerId,
                        sub.trial_end || null
                    ]);

                    console.log(`🎉 Subscription activated: ${plan}`);
                    break;
                }

                /**********************************************
                 *  SUBSCRIPTION UPDATED (UPGRADE / DOWNGRADE)
                 **********************************************/
                case "customer.subscription.updated": {
                    const sub = obj;
                    const customerId = sub.customer;
                    const subscriptionId = sub.id;

                    const priceId = sub.items.data[0].price.id;

                    let plan = "none";
                    if (priceId === process.env.STRIPE_BASIC_PRICE_ID) plan = "basic";
                    if (priceId === process.env.STRIPE_PLUS_PRICE_ID) plan = "plus";
                    if (priceId === process.env.STRIPE_FREETRIAL_PRICE_ID) plan = "trial";

                    await db.query(`
                        UPDATE customers
                        SET
                            has_subscription = true,
                            current_plan = $1,
                            stripe_subscription_id = $2,
                            subscription_end = NULL
                        WHERE stripe_customer_id = $3
                    `, [plan, subscriptionId, customerId]);

                    console.log(`🔄 Subscription updated: ${plan}`);
                    break;
                }

                /**********************************************
                 *  SUBSCRIPTION CANCELED
                 **********************************************/
                case "customer.subscription.deleted": {
                    const customerId = obj.customer;

                    // Stripe sends cancel_at_period_end info
                    const activeUntil = obj.cancel_at_period_end
                        ? obj.current_period_end
                        : null;

                    await db.query(`
                        UPDATE customers
                        SET 
                            has_subscription = false,
                            current_plan = 'none',
                            stripe_subscription_id = NULL,
                            subscription_end = (CASE 
                                WHEN $1 IS NULL THEN NOW()
                                ELSE to_timestamp($1)
                            END)
                        WHERE stripe_customer_id = $2
                    `, [
                        activeUntil,
                        customerId
                    ]);

                    console.log("❌ Subscription canceled");
                    break;
                }

                /**********************************************
                 *  INVOICE PAID (JUST LOGGING)
                 **********************************************/
                case "invoice.paid": {
                    console.log("💰 Invoice paid");
                    break;
                }
            }

        } catch (err) {
            console.error("❌ Stripe Webhook Error:", err);
        }

        res.json({ received: true });
    }
);

/***************************************************************
 *  GLOBAL MIDDLEWARE (JSON / CORS / STATIC)
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
 *  DATABASE
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
    .then(() => console.log("✅ DATABASE CONNECTED"))
    .catch(err => console.error("❌ DB ERROR:", err));

global.__LT_pool = pool;

/***************************************************************
 *  STRIPE INIT
 ***************************************************************/
let stripe = null;

if (process.env.STRIPE_SECRET_KEY) {
    stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    console.log("⚡ STRIPE INITIALIZED");
}

global.__LT_stripe = stripe;

/***************************************************************
 *  HELPERS + PRICE MAP
 ***************************************************************/
function sanitize(str) {
    if (!str || typeof str !== "string") return str;
    return str.replace(/[<>'"]/g, "");
}
function generateToken(payload) {
    return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });
}
global.__LT_sanitize = sanitize;
global.__LT_generateToken = generateToken;

global.__LT_prices = {
    "free-trial": process.env.STRIPE_FREETRIAL_PRICE_ID,
    "love-basic": process.env.STRIPE_BASIC_PRICE_ID,
    "love-plus": process.env.STRIPE_PLUS_PRICE_ID
};
/***************************************************************
 *  LoveTextForHer — BACKEND (PART 2 OF 7)
 *  ----------------------------------------------------------
 *  Includes:
 *      ✔ Message templates for all relationships
 *      ✔ Message builder
 *      ✔ Email HTML builder
 *      ✔ Default admin seeder
 *      ✔ Plan normalization + limits
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
        "Someone can't stop thinking of you 🌹",
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
 *  MESSAGE BUILDER
 ***************************************************************/
function buildMessage(name, relationship) {
    const safeName = global.__LT_sanitize(name);
    const set =
        MESSAGE_TEMPLATES[relationship?.toLowerCase()] ||
        MESSAGE_TEMPLATES.default;

    const template = set[Math.floor(Math.random() * set.length)];
    return template.replace("{name}", safeName);
}

/***************************************************************
 *  EMAIL HTML BUILDER
 ***************************************************************/
function buildLoveEmailHTML(name, message, unsubscribeURL) {
    const safeName = global.__LT_sanitize(name);
    const safeMsg = global.__LT_sanitize(message);

    return `
        <div style="font-family:Arial;padding:20px;">
            <h2 style="color:#d6336c;">Hello ${safeName} ❤️</h2>
            <p style="font-size:16px; line-height:1.6;">
                ${safeMsg}
            </p>
            <br>
            <a href="${unsubscribeURL}"
               style="color:#999; font-size:12px;">
                Unsubscribe
            </a>
        </div>
    `;
}

/***************************************************************
 *  DEFAULT ADMIN SEEDER
 ***************************************************************/
async function seedAdmin() {
    try {
        const exists = await global.__LT_pool.query(
            "SELECT id FROM admins LIMIT 1"
        );

        if (exists.rows.length === 0) {
            const hash = await bcrypt.hash("Admin123!", 10);

            await global.__LT_pool.query(
                `INSERT INTO admins (email, password_hash)
                 VALUES ($1,$2)`,
                ["admin@lovetextforher.com", hash]
            );

            console.log("🌟 Default admin created: admin@lovetextforher.com / Admin123!");
        }
    } catch (err) {
        console.error("❌ ADMIN SEED ERROR:", err);
    }
}

seedAdmin();

/***************************************************************
 *  PLAN NORMALIZATION
 ***************************************************************/
function normalizePlan(productId) {
    if (productId === "free-trial") return "trial";
    if (productId === "love-basic") return "basic";
    if (productId === "love-plus") return "plus";
    return "none";
}

/***************************************************************
 *  PLAN LIMITS
 ***************************************************************/
function getRecipientLimit(plan) {
    if (plan === "plus") return Infinity;
    if (plan === "trial") return Infinity;  // trial = full unlimited
    if (plan === "basic") return 3;
    return 0;
}

/***************************************************************
 *  ENFORCE LIMITS AFTER DOWNGRADE
 ***************************************************************/
async function enforceRecipientLimit(customerId, newPlan) {
    const limit = getRecipientLimit(newPlan);

    if (limit === Infinity) return;

    const q = await global.__LT_pool.query(`
        SELECT id FROM users
        WHERE customer_id=$1
        ORDER BY id DESC
    `, [customerId]);

    const rows = q.rows;
    if (rows.length <= limit) return;

    const excess = rows.slice(limit).map(r => r.id);

    await global.__LT_pool.query(
        `DELETE FROM users WHERE id = ANY($1)`,
        [excess]
    );

    console.log(`⚠️ Removed ${excess.length} recipients due to downgrade.`);
}

/***************************************************************
 *  EXPORT HELPERS GLOBALLY
 ***************************************************************/
global.__LT_buildMessage = buildMessage;
global.__LT_buildLoveEmailHTML = buildLoveEmailHTML;
global.__LT_normalizePlan = normalizePlan;
global.__LT_getRecipientLimit = getRecipientLimit;
global.__LT_enforceRecipientLimit = enforceRecipientLimit;
/***************************************************************
 *  LoveTextForHer — BACKEND (PART 3 OF 7)
 *  ----------------------------------------------------------
 *  Includes:
 *      ✔ Customer Register/Login/Logout
 *      ✔ Admin Login/Logout
 *      ✔ /me session endpoints
 *      ✔ Secure cookie handling
 ***************************************************************/

/***************************************************************
 *  CUSTOMER REGISTRATION
 ***************************************************************/
app.post("/api/customer/register", async (req, res) => {
    try {
        let { email, password, name } = req.body;

        email = global.__LT_sanitize(email);
        name  = global.__LT_sanitize(name);

        if (!email || !password || !name)
            return res.status(400).json({ error: "All fields required" });

        if (password.length < 6)
            return res.status(400).json({ error: "Password too short" });

        const exists = await global.__LT_pool.query(
            "SELECT id FROM customers WHERE email=$1",
            [email]
        );

        if (exists.rows.length > 0)
            return res.status(400).json({ error: "Email already exists" });

        const hash = await bcrypt.hash(password, 10);

        await global.__LT_pool.query(
            `INSERT INTO customers
                (email, password_hash, name,
                 has_subscription, current_plan,
                 trial_active, trial_end)
             VALUES ($1,$2,$3,false,'none',false,NULL)`,
            [email, hash, name]
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
        email = global.__LT_sanitize(email);

        const q = await global.__LT_pool.query(
            "SELECT * FROM customers WHERE email=$1",
            [email]
        );

        if (!q.rows.length)
            return res.status(400).json({ error: "Invalid credentials" });

        const customer = q.rows[0];

        const valid = await bcrypt.compare(password, customer.password_hash);
        if (!valid)
            return res.status(400).json({ error: "Invalid credentials" });

        const token = global.__LT_generateToken({
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
        console.error("CUSTOMER LOGIN ERROR:", err);
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
        email = global.__LT_sanitize(email);

        const q = await global.__LT_pool.query(
            "SELECT * FROM admins WHERE email=$1",
            [email]
        );

        if (!q.rows.length)
            return res.status(400).json({ error: "Invalid credentials" });

        const admin = q.rows[0];

        const valid = await bcrypt.compare(password, admin.password_hash);
        if (!valid)
            return res.status(400).json({ error: "Invalid credentials" });

        const token = global.__LT_generateToken({
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
global.__LT_authCustomer = function (req, res, next) {
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
global.__LT_authAdmin = function (req, res, next) {
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
 *  ADMIN: /me
 ***************************************************************/
app.get("/api/admin/me", global.__LT_authAdmin, (req, res) => {
    return res.json({
        admin: {
            id: req.admin.id,
            email: req.admin.email,
            role: "admin"
        }
    });
});

/***************************************************************
 *  CUSTOMER: /me
 ***************************************************************/
app.get("/api/customer/me", global.__LT_authCustomer, async (req, res) => {
    try {
        const q = await global.__LT_pool.query(
            `SELECT id, email, name, has_subscription, current_plan
             FROM customers
             WHERE id=$1`,
            [req.user.id]
        );

        if (!q.rows.length)
            return res.status(404).json({ customer: null });

        return res.json({ customer: q.rows[0] });

    } catch (err) {
        console.error("CUSTOMER /me ERROR:", err);
        return res.status(500).json({ customer: null });
    }
});
/***************************************************************
 *  LoveTextForHer — BACKEND (PART 4 OF 7)
 *  ----------------------------------------------------------
 *  Includes:
 *      ✔ Ensure Stripe Customer ID
 *      ✔ Get subscription status
 *      ✔ Checkout (trial / basic / plus)
 *      ✔ Upgrades & downgrades
 *      ✔ Billing portal
 ***************************************************************/

/***************************************************************
 *  LOAD CUSTOMER RECORD
 ***************************************************************/
async function getCustomerRecord(id) {
    const q = await global.__LT_pool.query(
        "SELECT * FROM customers WHERE id=$1",
        [id]
    );
    return q.rows[0] || null;
}

/***************************************************************
 *  ENSURE STRIPE CUSTOMER
 ***************************************************************/
async function ensureStripeCustomer(customer) {
    if (customer.stripe_customer_id) return customer.stripe_customer_id;

    const sc = await global.__LT_stripe.customers.create({
        email: customer.email
    });

    await global.__LT_pool.query(
        "UPDATE customers SET stripe_customer_id=$1 WHERE id=$2",
        [sc.id, customer.id]
    );

    return sc.id;
}

/***************************************************************
 *  GET SUBSCRIPTION STATUS  — FINAL, CORRECT VERSION
 ***************************************************************/
app.get("/api/customer/subscription", global.__LT_authCustomer, async (req, res) => {
    try {
        const q = await pool.query(
            `SELECT 
                has_subscription,
                current_plan,
                trial_active,
                trial_end,
                stripe_subscription_id,
                subscription_end
             FROM customers
             WHERE id = $1`,
            [req.user.id]
        );

        if (!q.rows.length) {
            return res.status(404).json({ error: "Customer not found" });
        }

        const c = q.rows[0];

        let subscribed = false;

        /*
            LOGIC SUMMARY:

            has_subscription = true        → fully active plan
            subscription_end NOT null      → canceled but still active until date
            else                           → no plan
        */

        if (c.has_subscription === true) subscribed = true;
        if (c.subscription_end !== null) subscribed = true;

        return res.json({
            has_subscription: c.has_subscription,
            subscribed,                         // <– products page uses this
            current_plan: c.current_plan,
            trial_active: c.trial_active,
            trial_end: c.trial_end,
            stripe_subscription_id: c.stripe_subscription_id,
            subscription_end: c.subscription_end
        });

    } catch (err) {
        console.error("SUB STATUS ERROR:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/***************************************************************
 *  STRIPE CHECKOUT (NEW / UPGRADE / DOWNGRADE)
 ***************************************************************/
app.post("/api/stripe/checkout", global.__LT_authCustomer, async (req, res) => {
    const { productId } = req.body;

    try {
        const customer = await getCustomerRecord(req.user.id);
        if (!customer)
            return res.status(404).json({ error: "Customer not found" });

        const priceId = global.__LT_prices[productId];
        if (!priceId)
            return res.status(400).json({ error: "Invalid product" });

        const newPlan = global.__LT_normalizePlan(productId);

        // Stripe customer
        const stripeCustomerId = await ensureStripeCustomer(customer);

        // Try to load subscription from Stripe (if exists)
        let stripeSub = null;
        if (customer.stripe_subscription_id) {
            try {
                stripeSub = await stripe.subscriptions.retrieve(
                    customer.stripe_subscription_id
                );
            } catch {}
        }

        /***********************************************************
         * TRIAL GUARD
         ***********************************************************/
        if (newPlan === "trial" && customer.has_subscription === true) {
            return res.status(400).json({
                error: "Trial not available after previous subscription."
            });
        }

        /***********************************************************
         * CASE 1 — SUBSCRIPTION EXISTS AND IS ACTIVE
         ***********************************************************/
        if (stripeSub && stripeSub.status !== "canceled") {

            // upgrade/downgrade
            const itemId = stripeSub.items.data[0].id;

            await stripe.subscriptions.update(stripeSub.id, {
                cancel_at_period_end: false,
                proration_behavior: "always_invoice",
                items: [{ id: itemId, price: priceId }]
            });

            // Update DB
            await pool.query(
                `UPDATE customers SET
                    current_plan=$1,
                    has_subscription=true,
                    trial_active=false,
                    trial_end=NULL,
                    subscription_end=NULL
                 WHERE id=$2`,
                [newPlan, customer.id]
            );

            return res.json({ url: "/dashboard.html" });
        }

        /***********************************************************
         * CASE 2 — SUBSCRIPTION WAS CANCELED → CREATE A NEW ONE
         ***********************************************************/
        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            customer: stripeCustomerId,
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${process.env.BASE_URL}/success.html`,
            cancel_url: `${process.env.BASE_URL}/products.html`,
            subscription_data: {
                metadata: {
                    customer_id: customer.id,
                    plan: productId
                }
            }
        });

        return res.json({ url: session.url });

    } catch (err) {
        console.error("CHECKOUT ERROR:", err);
        return res.status(500).json({ error: "Checkout error" });
    }
});

/***************************************************************
 *  BILLING PORTAL
 ***************************************************************/
app.get("/api/customer/subscription/portal", global.__LT_authCustomer, async (req, res) => {
    try {
        const q = await global.__LT_pool.query(
            "SELECT stripe_customer_id FROM customers WHERE id=$1",
            [req.user.id]
        );

        if (!q.rows.length || !q.rows[0].stripe_customer_id)
            return res.status(400).json({ error: "No Stripe customer found" });

        const portal = await global.__LT_stripe.billingPortal.sessions.create({
            customer: q.rows[0].stripe_customer_id,
            return_url: `${process.env.BASE_URL}/dashboard.html`
        });

        return res.json({ url: portal.url });

    } catch (err) {
        console.error("PORTAL ERROR:", err);
        return res.status(500).json({ error: "Failed to open billing portal" });
    }
});
/***************************************************************
 *  LoveTextForHer — BACKEND (PART 5 OF 7)
 *  ----------------------------------------------------------
 *  Includes:
 *      ✔ Recipients (list/add/delete)
 *      ✔ Recipient limit enforcement
 *      ✔ Message logs
 *      ✔ Public unsubscribe system
 *      ✔ Admin controls (view/delete/send-now)
 ***************************************************************/

/***************************************************************
 *  LOG MESSAGE — used by cron & admin-send
 ***************************************************************/
async function logMessage(customerId, recipientId, email, message) {
    try {
        await global.__LT_pool.query(
            `INSERT INTO message_logs (customer_id, recipient_id, email, message)
             VALUES ($1,$2,$3,$4)`,
            [customerId, recipientId, email, message]
        );
    } catch (err) {
        console.error("LOG MESSAGE ERROR:", err);
    }
}
global.__LT_logMessage = logMessage;

/***************************************************************
 *  GET RECIPIENTS FOR CUSTOMER
 ***************************************************************/
app.get("/api/customer/recipients", global.__LT_authCustomer, async (req, res) => {
    try {
        const q = await global.__LT_pool.query(
            `SELECT 
                id, email, name, relationship, frequency, timings, timezone,
                next_delivery, last_sent, is_active
             FROM users
             WHERE customer_id=$1
             ORDER BY id DESC`,
            [req.user.id]
        );

        return res.json(q.rows);

    } catch (err) {
        console.error("RECIPIENT LIST ERROR:", err);
        return res.status(500).json({ error: "Server error loading recipients" });
    }
});
/***************************************************************
 *  CUSTOMER — SEND FLOWER (SIMILAR TO SEND NOW)
 ***************************************************************/
app.post("/api/customer/send-flowers/:id", global.__LT_authCustomer, async (req, res) => {
    try {
        const rid = req.params.id;
        const { note } = req.body;

        const q = await global.__LT_pool.query(
            "SELECT * FROM users WHERE id=$1 AND customer_id=$2",
            [rid, req.user.id]
        );

        if (!q.rows.length)
            return res.status(404).json({ error: "Recipient not found" });

        const r = q.rows[0];

        const unsubscribeURL =
            `${process.env.BASE_URL}/unsubscribe.html?token=${r.unsubscribe_token}`;

        const message = note || "🌸 A flower to brighten your day!";
        const html = global.__LT_buildLoveEmailHTML(
            r.name,
            message,
            unsubscribeURL
        );

        // Send email
        await global.__LT_sendEmail(
            r.email,
            "You received a flower 🌸",
            html,
            message + "\n\nUnsubscribe: " + unsubscribeURL
        );

        // Log the send
        await global.__LT_pool.query(
            `INSERT INTO message_logs (customer_id, recipient_id, email, message)
             VALUES ($1, $2, $3, $4)`,
            [req.user.id, rid, r.email, message]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("FLOWER SEND ERROR:", err);
        return res.status(500).json({ error: "Error sending flower." });
    }
});
/***************************************************************
 *  COUNT RECIPIENTS (for plan limits)
 ***************************************************************/
async function countRecipients(customerId) {
    const q = await global.__LT_pool.query(
        "SELECT COUNT(*) FROM users WHERE customer_id=$1",
        [customerId]
    );
    return Number(q.rows[0].count);
}

/***************************************************************
 *  ADD RECIPIENT
 ***************************************************************/
app.post("/api/customer/recipients", global.__LT_authCustomer, async (req, res) => {
    try {
        const q = await global.__LT_pool.query(
            "SELECT * FROM customers WHERE id=$1",
            [req.user.id]
        );

        if (!q.rows.length)
            return res.status(404).json({ error: "Customer not found" });

        const customer = q.rows[0];

        // enforce plan limits
        const maxAllowed = global.__LT_getRecipientLimit(customer.current_plan);
        const currentCount = await countRecipients(customer.id);

        if (currentCount >= maxAllowed) {
            return res.status(400).json({
                error: "Your subscription plan does not allow more recipients."
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

        name = global.__LT_sanitize(name);
        email = global.__LT_sanitize(email);
        relationship = global.__LT_sanitize(relationship);
        frequency = global.__LT_sanitize(frequency);
        timings = global.__LT_sanitize(timings);
        timezone = global.__LT_sanitize(timezone);

        if (!email || !name)
            return res.status(400).json({ error: "Name & email required" });

        const unsubscribeToken = crypto.randomBytes(16).toString("hex");

        await global.__LT_pool.query(
            `INSERT INTO users 
                (email, customer_id, name, relationship, frequency,
                 timings, timezone, unsubscribe_token, is_active,
                 next_delivery, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,NOW(),NOW())`,
            [
                email, customer.id, name, relationship, frequency,
                timings, timezone, unsubscribeToken
            ]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("ADD RECIPIENT ERROR:", err);
        return res.status(500).json({ error: "Server error adding recipient" });
    }
});

/***************************************************************
 *  DELETE RECIPIENT
 ***************************************************************/
app.delete("/api/customer/recipients/:id", global.__LT_authCustomer, async (req, res) => {
    try {
        await global.__LT_pool.query(
            `DELETE FROM users WHERE id=$1 AND customer_id=$2`,
            [req.params.id, req.user.id]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("DELETE RECIPIENT ERROR:", err);
        return res.status(500).json({ error: "Server error deleting recipient" });
    }
});

/***************************************************************
 *  MESSAGE LOG — last 5 messages
 ***************************************************************/
app.get("/api/message-log/:recipientId", global.__LT_authCustomer, async (req, res) => {
    try {
        const rid = req.params.recipientId;

        const logs = await global.__LT_pool.query(
            `SELECT message AS message_text, sent_at
             FROM message_logs
             WHERE customer_id=$1 AND recipient_id=$2
             ORDER BY sent_at DESC
             LIMIT 5`,
            [req.user.id, rid]
        );

        return res.json({ success: true, messages: logs.rows });

    } catch (err) {
        console.error("MESSAGE LOG ERROR:", err);
        return res.status(500).json({ error: "Error fetching message logs" });
    }
});

/***************************************************************
 *  PUBLIC UNSUBSCRIBE LINK
 ***************************************************************/
app.get("/api/unsubscribe/:token", async (req, res) => {
    try {
        const token = req.params.token;

        const q = await global.__LT_pool.query(
            "SELECT id FROM users WHERE unsubscribe_token=$1",
            [token]
        );

        if (!q.rows.length)
            return res.status(404).send("Invalid unsubscribe token.");

        const userId = q.rows[0].id;

        await global.__LT_pool.query(
            "UPDATE users SET is_active=false WHERE id=$1",
            [userId]
        );

        return res.send(`
            <h2 style="font-family:Arial">You've been unsubscribed ❤️</h2>
            <p style="font-family:Arial">You will no longer receive love messages.</p>
        `);

    } catch (err) {
        console.error("UNSUBSCRIBE ERROR:", err);
        return res.status(500).send("Error completing unsubscribe");
    }
});

/***************************************************************
 *  ADMIN — GET ALL RECIPIENTS
 ***************************************************************/
app.get("/api/admin/recipients", global.__LT_authAdmin, async (req, res) => {
    try {
        const q = await global.__LT_pool.query(
            `SELECT 
                id, customer_id, email, name, relationship, frequency,
                timings, timezone, next_delivery, last_sent, is_active
             FROM users
             ORDER BY id DESC`
        );

        return res.json(q.rows);

    } catch (err) {
        console.error("ADMIN RECIPIENTS ERROR:", err);
        return res.status(500).json({ error: "Server error loading recipients" });
    }
});

/***************************************************************
 *  ADMIN — DELETE RECIPIENT
 ***************************************************************/
app.delete("/api/admin/recipients/:id", global.__LT_authAdmin, async (req, res) => {
    try {
        await global.__LT_pool.query(
            "DELETE FROM users WHERE id=$1",
            [req.params.id]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("ADMIN DELETE ERROR:", err);
        return res.status(500).json({ error: "Server error deleting recipient" });
    }
});

/***************************************************************
 *  ADMIN — SEND NOW (manual email)
 ***************************************************************/
app.post("/api/admin/send-now/:id", global.__LT_authAdmin, async (req, res) => {
    try {
        const rid = req.params.id;

        const q = await global.__LT_pool.query(
            "SELECT * FROM users WHERE id=$1",
            [rid]
        );

        if (!q.rows.length)
            return res.status(404).json({ error: "Recipient not found" });

        const r = q.rows[0];

        const unsubscribeURL =
            `${process.env.BASE_URL}/unsubscribe.html?token=${r.unsubscribe_token}`;

        const message = global.__LT_buildMessage(r.name, r.relationship);
        const html = global.__LT_buildLoveEmailHTML(r.name, message, unsubscribeURL);

        await global.__LT_sendEmail(
            r.email,
            "Your Love Message ❤️",
            html,
            message + "\nUnsubscribe: " + unsubscribeURL
        );

        await logMessage(r.customer_id, r.id, r.email, message);

        return res.json({ success: true });

    } catch (err) {
        console.error("ADMIN SEND-NOW ERROR:", err);
        return res.status(500).json({ error: "Failed to send now" });
    }
});
/***************************************************************
 *  LoveTextForHer — BACKEND (PART 6 OF 7)
 *  ----------------------------------------------------------
 *  Includes:
 *      ✔ Customer Cart (load/add/remove)
 *      ✔ Merch Checkout (Stripe one-time payment)
 *      ✔ Password Reset (request + change)
 *      ✔ Resend email integration
 ***************************************************************/

/***************************************************************
 *  RESEND EMAIL CLIENT
 ***************************************************************/
const resend = new Resend(process.env.RESEND_API_KEY);

/***************************************************************
 *  UNIVERSAL EMAIL SENDER
 ***************************************************************/
global.__LT_sendEmail = async function (to, subject, html, textVersion) {
    try {
        await resend.emails.send({
            from: process.env.FROM_EMAIL,
            to,
            subject,
            html,
            text: textVersion || ""
        });
        return true;
    } catch (err) {
        console.error("❌ EMAIL SEND ERROR:", err);
        return false;
    }
};

/***************************************************************
 *  GET CART ITEMS
 ***************************************************************/
app.get("/api/cart", global.__LT_authCustomer, async (req, res) => {
    try {
        const q = await global.__LT_pool.query(
            "SELECT items FROM carts WHERE customer_id=$1",
            [req.user.id]
        );

        if (!q.rows.length) {
            return res.json({ items: [] });
        }

        return res.json({ items: q.rows[0].items || [] });

    } catch (err) {
        console.error("CART LOAD ERROR:", err);
        return res.status(500).json({ error: "Server error loading cart" });
    }
});

/***************************************************************
 *  ADD ITEM TO CART
 ***************************************************************/
app.post("/api/cart/add", global.__LT_authCustomer, async (req, res) => {
    try {
        let { productId, name, price } = req.body;

        productId = global.__LT_sanitize(productId);
        name = global.__LT_sanitize(name);
        price = Number(price);

        if (!productId || !name || !price) {
            return res.status(400).json({ error: "Invalid product" });
        }

        const existing = await global.__LT_pool.query(
            "SELECT items FROM carts WHERE customer_id=$1",
            [req.user.id]
        );

        const items = existing.rows.length ? existing.rows[0].items || [] : [];

        items.push({ productId, name, price });

        await global.__LT_pool.query(
            `INSERT INTO carts (customer_id, items)
             VALUES ($1, $2)
             ON CONFLICT (customer_id)
             DO UPDATE SET items=$2`,
            [req.user.id, JSON.stringify(items)]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("CART ADD ERROR:", err);
        return res.status(500).json({ error: "Server error adding to cart" });
    }
});

/***************************************************************
 *  REMOVE ITEM FROM CART
 ***************************************************************/
app.post("/api/cart/remove", global.__LT_authCustomer, async (req, res) => {
    try {
        let { productId } = req.body;
        productId = global.__LT_sanitize(productId);

        const q = await global.__LT_pool.query(
            "SELECT items FROM carts WHERE customer_id=$1",
            [req.user.id]
        );

        if (!q.rows.length) {
            return res.json({ success: true }); // nothing to remove
        }

        const filtered = (q.rows[0].items || []).filter(
            i => i.productId !== productId
        );

        await global.__LT_pool.query(
            "UPDATE carts SET items=$1 WHERE customer_id=$2",
            [JSON.stringify(filtered), req.user.id]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("CART REMOVE ERROR:", err);
        return res.status(500).json({ error: "Server error removing product" });
    }
});

/***************************************************************
 *  PASSWORD RESET — REQUEST RESET TOKEN
 ***************************************************************/
app.post("/api/password/request", async (req, res) => {
    try {
        let { email } = req.body;
        email = global.__LT_sanitize(email);

        if (!email)
            return res.status(400).json({ error: "Email required" });

        const q = await global.__LT_pool.query(
            "SELECT id FROM customers WHERE email=$1",
            [email]
        );

        // Always say success for security
        if (!q.rows.length)
            return res.json({ success: true });

        const customerId = q.rows[0].id;

        // Invalidate old tokens
        await global.__LT_pool.query(
            `UPDATE password_reset_tokens SET used=true WHERE customer_id=$1`,
            [customerId]
        );

        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

        await global.__LT_pool.query(
            `INSERT INTO password_reset_tokens (customer_id, token, expires_at)
             VALUES ($1,$2,$3)`,
            [customerId, token, expiresAt]
        );

        const resetURL = `${process.env.BASE_URL}/reset_password.html?token=${token}`;

        const html = `
            <div style="font-family:Arial;padding:20px;">
                <h2>Password Reset Request</h2>
                <p>Click below to reset your password. This link expires in 15 minutes.</p>
                <a href="${resetURL}" style="color:#d6336c;">Reset Password</a>
            </div>
        `;

        await global.__LT_sendEmail(
            email,
            "Reset Your Password",
            html,
            `Reset your password: ${resetURL}`
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("PASSWORD REQUEST ERROR:", err);
        return res.status(500).json({ error: "Server error requesting reset" });
    }
});

/***************************************************************
 *  PASSWORD RESET — CHANGE PASSWORD
 ***************************************************************/
app.post("/api/password/reset", async (req, res) => {
    try {
        let { token, password } = req.body;

        if (!token || !password)
            return res.status(400).json({ error: "Missing fields" });

        if (password.length < 6)
            return res.status(400).json({ error: "Password too short" });

        const q = await global.__LT_pool.query(
            `SELECT * FROM password_reset_tokens
             WHERE token=$1 AND used=false`,
            [token]
        );

        if (!q.rows.length)
            return res.status(400).json({ error: "Invalid or expired token" });

        const record = q.rows[0];

        if (new Date() > new Date(record.expires_at)) {
            return res.status(400).json({ error: "Token expired" });
        }

        const hash = await bcrypt.hash(password, 10);

        await global.__LT_pool.query(
            `UPDATE customers SET password_hash=$1 WHERE id=$2`,
            [hash, record.customer_id]
        );

        await global.__LT_pool.query(
            `UPDATE password_reset_tokens SET used=true WHERE token=$1`,
            [token]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error("PASSWORD RESET ERROR:", err);
        return res.status(500).json({ error: "Server error resetting password" });
    }
});

/***************************************************************
 *  MERCH CHECKOUT — ONE-TIME STRIPE PAYMENT
 ***************************************************************/
app.post("/api/stripe/merch-checkout", global.__LT_authCustomer, async (req, res) => {
    try {
        if (!global.__LT_stripe)
            return res.status(500).json({ error: "Stripe not configured" });

        const { items } = req.body;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: "No items provided" });
        }

        const lineItems = items.map(item => ({
            price_data: {
                currency: "usd",
                product_data: { name: item.name },
                unit_amount: Math.round(Number(item.price) * 100)
            },
            quantity: 1
        }));

        const session = await global.__LT_stripe.checkout.sessions.create({
            mode: "payment",
            line_items: lineItems,
            success_url: `${process.env.BASE_URL}/success.html`,
            cancel_url: `${process.env.BASE_URL}/cart.html`,
            metadata: { customer_id: req.user.id }
        });

        // clear cart
        await global.__LT_pool.query(
            "UPDATE carts SET items='[]' WHERE customer_id=$1",
            [req.user.id]
        );

        return res.json({ url: session.url });

    } catch (err) {
        console.error("❌ MERCH CHECKOUT ERROR:", err);
        return res.status(500).json({ error: "Server error processing merch checkout" });
    }
});
/***************************************************************
 *  LoveTextForHer — BACKEND (PART 7 OF 7)
 *  ----------------------------------------------------------
 *  Includes:
 *      ✔ Next delivery calculator
 *      ✔ Cron job (runs every minute)
 *      ✔ Automated message sender
 *      ✔ Logging of sent messages
 *      ✔ Server start
 ***************************************************************/

/***************************************************************
 *  NEXT DELIVERY TIME CALCULATOR
 ***************************************************************/
function calculateNextDelivery(freq, timing) {
    const now = new Date();
    const next = new Date(now);

    // TIME OF DAY
    switch (timing) {
        case "morning":    next.setHours(9, 0, 0); break;
        case "afternoon":  next.setHours(13, 0, 0); break;
        case "evening":    next.setHours(18, 0, 0); break;
        case "night":      next.setHours(22, 0, 0); break;
        default:           next.setHours(12, 0, 0); break;
    }

    // FREQUENCY
    switch (freq) {
        case "daily":
            next.setDate(now.getDate() + 1);
            break;

        case "every-other-day":
            next.setDate(now.getDate() + 2);
            break;

        case "three-times-week":
            // simulate M/W/F spacing (+2 days)
            next.setDate(now.getDate() + 2);
            break;

        case "weekly":
            next.setDate(now.getDate() + 7);
            break;

        case "bi-weekly":
            next.setDate(now.getDate() + 14);
            break;

        default:
            next.setDate(now.getDate() + 1);
    }

    return next;
}

/***************************************************************
 *  CRON JOB — AUTOMATIC MESSAGE SENDER
 *  Runs every minute
 ***************************************************************/
cron.schedule("* * * * *", async () => {
    console.log("⏱  CRON: scanning for due messages…");

    const client = await global.__LT_pool.connect();

    try {
        const now = new Date();

        const due = await client.query(`
            SELECT *
            FROM users
            WHERE is_active=true
              AND next_delivery <= $1
        `, [now]);

        for (const r of due.rows) {
            try {
                const unsubscribeURL =
                    `${process.env.BASE_URL}/unsubscribe.html?token=${r.unsubscribe_token}`;

                const message =
                    global.__LT_buildMessage(r.name, r.relationship);

                const html =
                    global.__LT_buildLoveEmailHTML(r.name, message, unsubscribeURL);

                // SEND EMAIL
                await global.__LT_sendEmail(
                    r.email,
                    "Your Love Message ❤️",
                    html,
                    message + "\n\nUnsubscribe: " + unsubscribeURL
                );

                // LOG MESSAGE
                await global.__LT_logMessage(
                    r.customer_id,
                    r.id,
                    r.email,
                    message
                );

                // CALCULATE NEXT DELIVERY
                const next = calculateNextDelivery(r.frequency, r.timings);

                await client.query(`
                    UPDATE users
                    SET next_delivery=$1, last_sent=NOW()
                    WHERE id=$2
                `, [next, r.id]);

                console.log(`💘 Message sent → ${r.email}`);

            } catch (innerErr) {
                console.error("❌ Error sending automated email:", innerErr);
            }
        }

    } catch (err) {
        console.error("❌ CRON ERROR:", err);
    } finally {
        client.release();
    }
});

/***************************************************************
 *  SERVER START
 ***************************************************************/
app.listen(PORT, () => {
    console.log(`🚀 LoveTextForHer Backend Running on Port ${PORT}`);
});

/***************************************************************
 *  🎉 END OF PART 7 — BACKEND COMPLETE
 ***************************************************************/