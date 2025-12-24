/***************************************************************
 *  LoveTextForHer — BACKEND (PART 1 OF 7)
 *  FINAL VERSION (2025)
 *  ------------------------------------------------------------
 *  ✔ Stripe Webhook (single unified)
 *  ✔ Fixed cancellation/update logic
 *  ✔ No more “cannot update canceled subscription” errors
 *  ✔ Trial = one-time forever
 *  ✔ DB-safe, Stripe-safe, dashboard-safe
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

const app = express();
const PORT = process.env.PORT || 3000;

/***************************************************************
 *  STRIPE WEBHOOK — MUST BE FIRST (RAW BODY)
 *  COMPLETE FIXED VERSION - Replace entire webhook route
 ***************************************************************/
app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
        if (!process.env.STRIPE_SECRET_KEY) {
            return res.status(200).send("Stripe disabled");
        }

        const stripe = global.__LT_stripe;
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

        const db = global.__LT_pool;
        const type = event.type;
        const obj = event.data.object;

        console.log(`⚡ WEBHOOK: ${type}`);

        try {
            /***********************************************************
             * CHECKOUT COMPLETED
             ***********************************************************/
if (type === "checkout.session.completed") {
    const customerId = obj.customer;
    const subId = obj.subscription;
    if (!subId) return res.json({ received: true });

    const sub = await stripe.subscriptions.retrieve(subId);
    const priceId = sub.items.data[0].price.id;

    let plan = "none";
    if (priceId === process.env.STRIPE_BASIC_PRICE_ID) plan = "basic";
    if (priceId === process.env.STRIPE_PLUS_PRICE_ID) plan = "plus";
    if (priceId === process.env.STRIPE_FREETRIAL_PRICE_ID) plan = "trial";

    // ✅ Calculate trial end as exactly 3 days from now
    let trialEnd = null;
    if (plan === "trial") {
        trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + 3);
        trialEnd.setHours(23, 59, 59, 999);
    }

    // ✅ FIX: Only mark trial_used when trial checkout completes
    await db.query(`
        UPDATE customers
        SET 
            has_subscription = true,
            current_plan = $1,
            stripe_subscription_id = $2,
            stripe_customer_id = $3,
            trial_active = ($1 = 'trial'),
            trial_end = $4,
            trial_used = ($1 = 'trial'),
            subscription_end = NULL
        WHERE stripe_customer_id = $3
    `, [plan, subId, customerId, trialEnd]);

    console.log(`🎉 Subscription started: ${plan}${plan === 'trial' ? ' (ends ' + trialEnd.toISOString() + ')' : ''}`);
}


            /***********************************************************
             * SUBSCRIPTION UPDATED
             ***********************************************************/
            if (type === "customer.subscription.updated") {
                const customerId = obj.customer;
                const subId = obj.id;
                
                const check = await db.query(
                    `SELECT stripe_subscription_id, id FROM customers WHERE stripe_customer_id=$1`,
                    [customerId]
                );
                
                if (check.rows.length === 0 || check.rows[0].stripe_subscription_id !== subId) {
                    console.log(`⚠️  Ignoring update for non-current subscription ${subId}`);
                    return res.json({ received: true });
                }
                
                const customer_db_id = check.rows[0].id;
                const priceId = obj.items.data[0].price.id;

                let plan = "none";
                if (priceId === process.env.STRIPE_BASIC_PRICE_ID) plan = "basic";
                if (priceId === process.env.STRIPE_PLUS_PRICE_ID) plan = "plus";
                if (priceId === process.env.STRIPE_FREETRIAL_PRICE_ID) plan = "trial";

                const isCanceled = obj.status === "canceled";
                const isCanceling = obj.cancel_at_period_end === true;
                
                const subscriptionEnd = isCanceling 
                    ? new Date(obj.current_period_end * 1000)
                    : null;

                if (isCanceled) {
                    console.log(`❌ IMMEDIATE CANCELLATION DETECTED`);
                    
                    await db.query(`DELETE FROM users WHERE customer_id = $1`, [customer_db_id]);
                    
                    await db.query(`
                        UPDATE customers
                        SET 
                            has_subscription = false,
                            current_plan = 'none',
                            stripe_subscription_id = NULL,
                            trial_active = false,
                            subscription_end = NULL
                        WHERE stripe_customer_id=$1
                    `, [customerId]);
                    
                    console.log(`🗑️  Immediate cancel - Deleted all recipients`);
                    return res.json({ received: true });
                }

                await db.query(`
                    UPDATE customers
                    SET
                        has_subscription = $1,
                        current_plan = $2,
                        subscription_end = $3,
                        trial_active = false
                    WHERE stripe_customer_id = $4
                `, [!isCanceling, plan, subscriptionEnd, customerId]);

                if (isCanceling) {
                    console.log(`🔄 Subscription scheduled to cancel at ${subscriptionEnd.toISOString()}`);
                } else {
                    console.log(`🔄 Subscription updated: ${plan}`);
                }
            }

            /***********************************************************
             * SUBSCRIPTION DELETED (Trial ended or period ended)
             ***********************************************************/
            if (type === "customer.subscription.deleted") {
                const customerId = obj.customer;
                
                const custQ = await db.query(
                    `SELECT id, current_plan FROM customers WHERE stripe_customer_id=$1`,
                    [customerId]
                );
                
                if (custQ.rows.length > 0) {
                    const customer_db_id = custQ.rows[0].id;
                    const plan = custQ.rows[0].current_plan;
                    
                    // Delete all recipients
                    await db.query(`DELETE FROM users WHERE customer_id = $1`, [customer_db_id]);
                    
                    console.log(`🗑️  ${plan === 'trial' ? 'Trial' : 'Subscription'} ended - Deleted all recipients`);
                }

                // Update customer record
                await db.query(`
                    UPDATE customers
                    SET 
                        has_subscription = false,
                        current_plan = 'none',
                        stripe_subscription_id = NULL,
                        trial_active = false,
                        trial_end = NULL,
                        subscription_end = NULL
                    WHERE stripe_customer_id=$1
                `, [customerId]);

                console.log("❌ Subscription fully ended - Access revoked");
            }

        } catch (err) {
            console.error("❌ Webhook handler error:", err);
        }

        return res.json({ received: true });
    }
);

/***************************************************************
 * EXPRESS MIDDLEWARE (after webhook)
***************************************************************/
/***************************************************************
 * EXPRESS MIDDLEWARE (after webhook)
***************************************************************/
const allowedOrigins = [
    process.env.FRONTEND_URL,
    'https://www.lovetextforher.com',
    'https://lovetextforher.com',
    'https://lovetextforher.netlify.app',
    'https://lovetextforher-backend.onrender.com',
    'http://localhost:3000',
    'http://localhost:5500'
];

app.use(cors({ 
    origin: function(origin, callback) {
        // Allow requests with no origin (like mobile apps or Postman)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.log('❌ CORS blocked origin:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true 
}));

// ✅ CRITICAL: Add body parsers AFTER CORS
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/***************************************************************
 * POSTGRES
 ***************************************************************/
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false }
});

global.__LT_pool = pool;

pool.query("SELECT NOW()")
    .then(() => console.log("✅ DATABASE CONNECTED"))
    .catch(err => console.error("❌ DB ERROR:", err));

/***************************************************************
 * STRIPE INIT
 ***************************************************************/
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
    stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    console.log("⚡ Stripe loaded");
}
global.__LT_stripe = stripe;

/***************************************************************
 * HELPERS
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

/***************************************************************
 * PRICE MAP
 ***************************************************************/
global.__LT_prices = {
    "free-trial": process.env.STRIPE_FREETRIAL_PRICE_ID,
    "love-basic": process.env.STRIPE_BASIC_PRICE_ID,
    "love-plus": process.env.STRIPE_PLUS_PRICE_ID
};

console.log("💰 PRICE MAP LOADED:", global.__LT_prices);
/***************************************************************
 *  LoveTextForHer — BACKEND (PART 2 OF 7)
 *  ----------------------------------------------------------
 *  ✔ Message templates
 *  ✔ Build message
 *  ✔ Build email HTML
 *  ✔ Admin seeder
 *  ✔ Plan normalization
 *  ✔ Plan limits
 *  ✔ Limit enforcement after downgrade
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
 *  BUILD LOVE MESSAGE
 ***************************************************************/
function buildMessage(name, relationship) {
    const cleanName = global.__LT_sanitize(name);
    const set =
        MESSAGE_TEMPLATES[relationship?.toLowerCase()] ||
        MESSAGE_TEMPLATES.default;

    const template = set[Math.floor(Math.random() * set.length)];
    return template.replace("{name}", cleanName);
}

/***************************************************************
 *  EMAIL BUILDER
 ***************************************************************/
function buildLoveEmailHTML(name, message, unsubscribeURL) {
    const cleanName = global.__LT_sanitize(name);
    const cleanMsg = global.__LT_sanitize(message);

    return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin:0;padding:0;font-family:Arial,sans-serif;background-color:#f5f5f5;">
            <div style="max-width:600px;margin:40px auto;background-color:white;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);">
                <div style="background-color:#d6336c;padding:30px;border-radius:8px 8px 0 0;text-align:center;">
                    <h1 style="color:white;margin:0;font-size:28px;">💌</h1>
                </div>
                <div style="padding:40px 30px;">
                    <h2 style="color:#d6336c;margin-top:0;">Hello ${cleanName} ❤️</h2>
                    <p style="font-size:18px;line-height:1.8;color:#333;margin:20px 0;">
                        ${cleanMsg}
                    </p>
                    <hr style="border:none;border-top:1px solid #eee;margin:30px 0;">
                    <p style="color:#999;font-size:12px;text-align:center;margin:0;">
                        Don't want to receive these messages?<br>
                        <a href="${unsubscribeURL}" 
                           style="color:#d6336c;text-decoration:none;font-weight:bold;">
                            Click here to unsubscribe
                        </a>
                    </p>
                </div>
            </div>
        </body>
        </html>
    `;
}

/***************************************************************
 *  DEFAULT ADMIN SEEDER
 ***************************************************************/
async function seedAdmin() {
    try {
        const result = await global.__LT_pool.query(
            "SELECT id FROM admins LIMIT 1"
        );

        if (result.rows.length === 0) {
            const hash = await bcrypt.hash("Admin123!", 10);

            await global.__LT_pool.query(
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
    if (plan === "trial") return Infinity;       // Trial = unlimited
    if (plan === "basic") return 3;              // Basic = only 3
    return 0;                                     // No plan = 0
}

/***************************************************************
 *  ENFORCE LIMITS AFTER DOWNGRADE
 ***************************************************************/
async function enforceRecipientLimit(customerId, newPlan) {
    const limit = getRecipientLimit(newPlan);

    if (limit === Infinity) return;

    const q = await global.__LT_pool.query(
        `SELECT id FROM users
         WHERE customer_id=$1
         ORDER BY id DESC`,
        [customerId]
    );

    const recipients = q.rows;

    if (recipients.length <= limit) return;

    const deleteIds = recipients.slice(limit).map(r => r.id);

    await global.__LT_pool.query(
        `DELETE FROM users WHERE id = ANY($1)`,
        [deleteIds]
    );

    console.log(`⚠️ Removed ${deleteIds.length} recipients due to downgrade.`);
}

/***************************************************************
 *  EXPORT GLOBALS
 ***************************************************************/
global.__LT_buildMessage = buildMessage;
global.__LT_buildLoveEmailHTML = buildLoveEmailHTML;
global.__LT_normalizePlan = normalizePlan;
global.__LT_getRecipientLimit = getRecipientLimit;
global.__LT_enforceRecipientLimit = enforceRecipientLimit;
/***************************************************************
 *  LoveTextForHer — BACKEND (PART 3 OF 7)
 *  ----------------------------------------------------------
 *  ✔ Customer Register/Login/Logout
 *  ✔ Admin Login/Logout
 *  ✔ Auth Middleware
 *  ✔ /me Endpoints
 ***************************************************************/

/***************************************************************
 * FIX 1: UPDATED REGISTRATION ENDPOINT
 * Replace the existing /api/customer/register endpoint
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

        // ✅ FIX: Explicitly set trial_used to FALSE on registration
        await global.__LT_pool.query(
            `INSERT INTO customers
                (email, password_hash, name,
                 has_subscription, current_plan,
                 trial_active, trial_end, trial_used,
                 stripe_customer_id, stripe_subscription_id,
                 subscription_end)
             VALUES ($1,$2,$3,false,'none',false,NULL,false,NULL,NULL,NULL)`,
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
 *  ADMIN — /me
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
 *  CUSTOMER — /me
 ***************************************************************/
app.get("/api/customer/me", global.__LT_authCustomer, async (req, res) => {
    try {
        const q = await global.__LT_pool.query(
            `SELECT 
                id, email, name, has_subscription, current_plan
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
 *  ✔ Ensure Stripe Customer
 *  ✔ Subscription Status (correct)
 *  ✔ Stripe Checkout
 *  ✔ Upgrade / Downgrade
 *  ✔ Billing Portal
 ***************************************************************/

/***************************************************************
 *  GET CUSTOMER RECORD
 ***************************************************************/
async function getCustomerRecord(id) {
    const q = await global.__LT_pool.query(
        "SELECT * FROM customers WHERE id=$1",
        [id]
    );
    return q.rows[0] || null;
}

/***************************************************************
 *  ENSURE STRIPE CUSTOMER EXISTS
 ***************************************************************/
async function ensureStripeCustomer(customer) {
    if (customer.stripe_customer_id) return customer.stripe_customer_id;

    const created = await global.__LT_stripe.customers.create({
        email: customer.email
    });

    await global.__LT_pool.query(
        "UPDATE customers SET stripe_customer_id=$1 WHERE id=$2",
        [created.id, customer.id]
    );

    return created.id;
}

/***************************************************************
 * FIX 2: UPDATED SUBSCRIPTION STATUS ENDPOINT
 * Replace the existing /api/customer/subscription endpoint
 ***************************************************************/
app.get("/api/customer/subscription",
    global.__LT_authCustomer,
    async (req, res) => {

    try {
        const q = await global.__LT_pool.query(
            `SELECT 
                has_subscription,
                current_plan,
                trial_active,
                trial_end,
                trial_used,
                stripe_subscription_id,
                subscription_end
             FROM customers
             WHERE id=$1`,
            [req.user.id]
        );

        if (!q.rows.length)
            return res.status(404).json({ error: "Customer not found" });

        const c = q.rows[0];
        const now = new Date();

        let subscribed = false;
        let status = "inactive";

        // ✅ FIX: Convert to boolean explicitly and check properly
        // trial_used will be true ONLY if they've actually used the trial
        const hasUsedTrial = c.trial_used === true;
        const trialEligible = !hasUsedTrial;

        console.log(`🔍 Trial Status Debug for customer ${req.user.id}:`, {
            trial_used_raw: c.trial_used,
            trial_used_type: typeof c.trial_used,
            hasUsedTrial: hasUsedTrial,
            trialEligible: trialEligible
        });

        // Check for active trial
        if (c.trial_active && c.trial_end && new Date(c.trial_end) > now) {
            subscribed = true;
            status = "trial";
        }
        // Active subscription (not canceled)
        else if (c.has_subscription === true && !c.subscription_end) {
            subscribed = true;
            status = "active";
        }
        // Canceled but still in paid period
        else if (c.subscription_end && new Date(c.subscription_end) > now) {
            subscribed = true;
            status = "canceling";
        }

        return res.json({
            has_subscription: c.has_subscription,
            subscribed,
            status,
            current_plan: c.current_plan,
            trial_active: c.trial_active,
            trial_end: c.trial_end,
            trial_used: hasUsedTrial,  // ✅ Return clean boolean
            trial_eligible: trialEligible,  // ✅ Return clean boolean
            stripe_subscription_id: c.stripe_subscription_id,
            subscription_end: c.subscription_end
        });

    } catch (err) {
        console.error("SUB STATUS ERROR:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/***************************************************************
 * FIX 3: UPDATED STRIPE CHECKOUT WITH BETTER TRIAL GUARD
 * Replace the trial guard section in /api/stripe/checkout
 ***************************************************************/
app.post("/api/stripe/checkout",
    global.__LT_authCustomer,
    async (req, res) => {

    const { productId } = req.body;

    try {
        const customer = await getCustomerRecord(req.user.id);
        if (!customer)
            return res.status(404).json({ error: "Customer not found" });

        const priceId = global.__LT_prices[productId];
        if (!priceId)
            return res.status(400).json({ error: "Invalid product" });

        const newPlan = global.__LT_normalizePlan(productId);

        const stripeCustomerId = await ensureStripeCustomer(customer);

        let stripeSub = null;
        if (customer.stripe_subscription_id) {
            try {
                stripeSub = await global.__LT_stripe.subscriptions.retrieve(
                    customer.stripe_subscription_id
                );
            } catch {
                stripeSub = null;
            }
        }

/***********************************************************
 * TRIAL GUARD — Only one trial ever (ENHANCED WITH DEBUG)
 ***********************************************************/
if (newPlan === "trial") {
    console.log(`🔍 Trial Check Debug for customer ${customer.id}:`, {
        trial_used_raw: customer.trial_used,
        trial_used_type: typeof customer.trial_used,
        trial_used_boolean: customer.trial_used === true,
        will_block: customer.trial_used === true
    });
    
    // ✅ FIX: Strict boolean check
    if (customer.trial_used === true) {
        return res.status(400).json({
            error: "You have already used your free trial."
        });
    }
    
    console.log(`✅ Trial eligible for customer ${customer.id}`);
}

        /***********************************************************
         * CASE 1 — ACTIVE SUB → UPGRADE / DOWNGRADE
         ***********************************************************/
        if (stripeSub && stripeSub.status !== "canceled") {
            const itemId = stripeSub.items.data[0].id;

            await global.__LT_stripe.subscriptions.update(
                stripeSub.id,
                {
                    cancel_at_period_end: false,
                    proration_behavior: "always_invoice",
                    items: [{ id: itemId, price: priceId }]
                }
            );

            await global.__LT_pool.query(
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
         * CASE 2 — CREATE NEW SUBSCRIPTION
         ***********************************************************/
        
        const sessionConfig = {
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
        };

        // ✅ If it's a trial, set trial period
        if (newPlan === "trial") {
            sessionConfig.subscription_data.trial_period_days = 3;
            sessionConfig.subscription_data.trial_settings = {
                end_behavior: {
                    missing_payment_method: 'cancel'
                }
            };
            
            // Note: trial_used is set by the webhook when checkout completes
            console.log(`🎟️  Creating trial checkout for customer ${customer.id}`);
        }

        const session = await global.__LT_stripe.checkout.sessions.create(sessionConfig);

        return res.json({ url: session.url });

    } catch (err) {
        console.error("CHECKOUT ERROR:", err);
        return res.status(500).json({ error: "Checkout error" });
    }
});

/***************************************************************
 *  BILLING PORTAL
 ***************************************************************/
app.get("/api/customer/subscription/portal",
    global.__LT_authCustomer,
    async (req, res) => {

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
 *      ✔ Send Flowers (recommended version)
 ***************************************************************/

/***************************************************************
 *  LOG MESSAGE — Used by cron & manual sends
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
        const customerQ = await global.__LT_pool.query(
            "SELECT * FROM customers WHERE id=$1",
            [req.user.id]
        );

        if (!customerQ.rows.length)
            return res.status(404).json({ error: "Customer not found" });

        const customer = customerQ.rows[0];
        
        // Check if subscription is active
        const now = new Date();
        const isActive = customer.has_subscription || 
                        (customer.subscription_end && new Date(customer.subscription_end) > now);
        
        if (!isActive) {
            return res.status(403).json({ 
                error: "You need an active subscription to add recipients." 
            });
        }

        // Enforce plan limits
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
            phone_number,
            delivery_method,
            relationship,
            frequency,
            timings,
            timezone
        } = req.body;

        // Sanitize all inputs
        name = global.__LT_sanitize(name);
        email = global.__LT_sanitize(email);
        phone_number = global.__LT_sanitize(phone_number);
        delivery_method = global.__LT_sanitize(delivery_method) || "email";
        relationship = global.__LT_sanitize(relationship);
        frequency = global.__LT_sanitize(frequency);
        timings = global.__LT_sanitize(timings);
        timezone = global.__LT_sanitize(timezone);

        // Validate required fields
        if (!name || !email)
            return res.status(400).json({ error: "Name & email required" });

        // Validate delivery method
        if (!["email", "sms", "both"].includes(delivery_method)) {
            delivery_method = "email";
        }

        // If SMS selected, require phone number
        if ((delivery_method === "sms" || delivery_method === "both") && !phone_number) {
            return res.status(400).json({ error: "Phone number required for SMS delivery" });
        }

        const unsubscribeToken = crypto.randomBytes(16).toString("hex");

        await global.__LT_pool.query(
            `INSERT INTO users 
                (email, phone_number, delivery_method, customer_id, name, 
                 relationship, frequency, timings, timezone, 
                 unsubscribe_token, is_active, next_delivery, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,NOW(),NOW())`,
            [
                email, 
                phone_number || null, 
                delivery_method, 
                customer.id, 
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
        return res.status(500).json({ error: "Server error adding recipient" });
    }
});

/***************************************************************
 *  DELETE RECIPIENT
 ***************************************************************/
/***************************************************************
 *  DELETE RECIPIENT
 ***************************************************************/

app.delete("/api/customer/recipients/:id", global.__LT_authCustomer, async (req, res) => {
    try {
        // Allow deletion regardless of subscription status
        // (Users should be able to manage their data even after canceling)
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
 *  UPDATED SEND FLOWERS ENDPOINT
 *  - Plus plan only
 *  - Maximum 2 flowers per recipient per day
 *  Replace your existing /api/customer/send-flowers/:id endpoint
 ***************************************************************/

app.post("/api/customer/send-flowers/:id", 
    global.__LT_authCustomer, 
    async (req, res) => {
    try {
        const rid = req.params.id;
        const { note } = req.body;

        // ✅ CHECK 1: Get customer plan
        const customerQ = await global.__LT_pool.query(
            "SELECT current_plan, has_subscription, subscription_end FROM customers WHERE id=$1",
            [req.user.id]
        );

        if (!customerQ.rows.length) {
            return res.status(404).json({ error: "Customer not found" });
        }

        const customer = customerQ.rows[0];

        // ✅ CHECK 2: Verify Plus plan
        if (customer.current_plan !== "plus") {
            return res.status(403).json({ 
                error: "Send Flowers is a Plus plan feature. Upgrade to access this feature.",
                requiresPlan: "plus"
            });
        }

        // ✅ CHECK 3: Verify active subscription
        const now = new Date();
        const isActive = customer.has_subscription || 
                        (customer.subscription_end && new Date(customer.subscription_end) > now);
        
        if (!isActive) {
            return res.status(403).json({ 
                error: "Your subscription is not active. Please renew to send flowers." 
            });
        }

        // ✅ CHECK 4: Get recipient
        const q = await global.__LT_pool.query(
            "SELECT * FROM users WHERE id=$1 AND customer_id=$2",
            [rid, req.user.id]
        );

        if (!q.rows.length) {
            return res.status(404).json({ error: "Recipient not found" });
        }

        const r = q.rows[0];

        // ✅ CHECK 5: Count flowers sent today to this recipient
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const flowerCountQ = await global.__LT_pool.query(
            `SELECT COUNT(*) FROM message_logs
             WHERE customer_id = $1 
             AND recipient_id = $2
             AND message LIKE '🌸 A flower for you!%'
             AND sent_at >= $3`,
            [req.user.id, rid, todayStart]
        );

        const flowersSentToday = Number(flowerCountQ.rows[0].count);

        if (flowersSentToday >= 2) {
            return res.status(429).json({ 
                error: "You've reached the daily limit of 2 flowers per recipient. Try again tomorrow!",
                limit: 2,
                sent: flowersSentToday
            });
        }

        // ✅ ALL CHECKS PASSED - SEND FLOWER
        const message = `🌸 A flower for you!` +
            (note?.trim() ? ` — ${global.__LT_sanitize(note.trim())}` : "");

        // SEND EMAIL (if delivery method includes email)
        if (!r.delivery_method || r.delivery_method === "email" || r.delivery_method === "both") {
            const unsubscribeURL = 
                `${process.env.BASE_URL}/unsubscribe.html?token=${r.unsubscribe_token}`;
            
            const html = global.__LT_buildLoveEmailHTML(r.name, message, unsubscribeURL);

            await global.__LT_sendEmail(
                r.email,
                "You received a flower 🌸",
                html,
                message + "\n\nUnsubscribe: " + unsubscribeURL
            );
            
            console.log(`💌 Flower email sent to ${r.email}`);
        }

        // SEND SMS (if delivery method includes SMS and phone exists)
        if ((r.delivery_method === "sms" || r.delivery_method === "both") && r.phone_number) {
            const smsMessage = `${message}\n\nReply STOP to unsubscribe`;
            await global.__LT_sendSMS(r.phone_number, smsMessage);
            console.log(`📱 Flower SMS sent to ${r.phone_number}`);
        }

        // Log the flower message
        await global.__LT_pool.query(
            `INSERT INTO message_logs (customer_id, recipient_id, email, message)
             VALUES ($1, $2, $3, $4)`,
            [req.user.id, rid, r.email, message]
        );

        return res.json({ 
            success: true,
            flowersSentToday: flowersSentToday + 1,
            remainingToday: 2 - (flowersSentToday + 1)
        });

    } catch (err) {
        console.error("❌ FLOWER SEND ERROR:", err);
        return res.status(500).json({ error: "Error sending flower." });
    }
});

/***************************************************************
 *  OPTIONAL: GET FLOWER STATUS FOR A RECIPIENT
 *  Shows how many flowers have been sent today
 ***************************************************************/
app.get("/api/customer/flower-status/:id",
    global.__LT_authCustomer,
    async (req, res) => {
    try {
        const rid = req.params.id;

        // Check customer plan
        const customerQ = await global.__LT_pool.query(
            "SELECT current_plan FROM customers WHERE id=$1",
            [req.user.id]
        );

        if (!customerQ.rows.length) {
            return res.status(404).json({ error: "Customer not found" });
        }

        const isPlusUser = customerQ.rows[0].current_plan === "plus";

        // Count flowers sent today
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const flowerCountQ = await global.__LT_pool.query(
            `SELECT COUNT(*) FROM message_logs
             WHERE customer_id = $1 
             AND recipient_id = $2
             AND message LIKE '🌸 A flower for you!%'
             AND sent_at >= $3`,
            [req.user.id, rid, todayStart]
        );

        const flowersSentToday = Number(flowerCountQ.rows[0].count);

        return res.json({
            isPlusUser,
            flowersSentToday,
            remainingToday: Math.max(0, 2 - flowersSentToday),
            dailyLimit: 2,
            canSendFlower: isPlusUser && flowersSentToday < 2
        });

    } catch (err) {
        console.error("❌ FLOWER STATUS ERROR:", err);
        return res.status(500).json({ error: "Error checking flower status" });
    }
});

/***************************************************************
 *  PUBLIC UNSUBSCRIBE LINK
 ***************************************************************/
app.get("/api/unsubscribe/:token", async (req, res) => {
    try {
        const token = req.params.token;

        const q = await global.__LT_pool.query(
            "SELECT id, name FROM users WHERE unsubscribe_token=$1",
            [token]
        );

        if (!q.rows.length)
            return res.status(404).send("Invalid unsubscribe token.");

        const recipientName = q.rows[0].name;

        // DELETE the recipient instead of just deactivating
        await global.__LT_pool.query(
            "DELETE FROM users WHERE id=$1",
            [q.rows[0].id]
        );

        console.log(`🗑️  Recipient unsubscribed and deleted: ${recipientName}`);

        return res.send(`
            <h2 style="font-family:Arial">You've been unsubscribed ❤️</h2>
            <p style="font-family:Arial">You will no longer receive love messages.</p>
            <p style="font-family:Arial;color:#999;font-size:14px;">Your information has been removed from our system.</p>
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
 *  ADMIN "SEND NOW" - ALSO FIXED FOR SMS (Part 5)
 *  Replace your existing /api/admin/send-now/:id endpoint
 ***************************************************************/
app.post("/api/admin/send-now/:id", 
    global.__LT_authAdmin, 
    async (req, res) => {
    try {
        const rid = req.params.id;

        const q = await global.__LT_pool.query(
            "SELECT * FROM users WHERE id=$1",
            [rid]
        );

        if (!q.rows.length)
            return res.status(404).json({ error: "Recipient not found" });

        const r = q.rows[0];

        const message = global.__LT_buildMessage(r.name, r.relationship);

        // SEND EMAIL
        if (!r.delivery_method || r.delivery_method === "email" || r.delivery_method === "both") {
            const unsubscribeURL =
                `${process.env.BASE_URL}/unsubscribe.html?token=${r.unsubscribe_token}`;

            const html = global.__LT_buildLoveEmailHTML(r.name, message, unsubscribeURL);

            await global.__LT_sendEmail(
                r.email,
                "Your Love Message ❤️",
                html,
                message + "\n\nUnsubscribe: " + unsubscribeURL
            );
            
            console.log(`💌 Admin email sent to ${r.email}`);
        }

        // SEND SMS
        if ((r.delivery_method === "sms" || r.delivery_method === "both") && r.phone_number) {
            const smsMessage = `${message}\n\nReply STOP to unsubscribe`;
            await global.__LT_sendSMS(r.phone_number, smsMessage);
            console.log(`📱 Admin SMS sent to ${r.phone_number}`);
        }

        await global.__LT_logMessage(r.customer_id, r.id, r.email, message);

        return res.json({ success: true });

    } catch (err) {
        console.error("❌ ADMIN SEND-NOW ERROR:", err);
        return res.status(500).json({ error: "Failed to send now" });
    }
});

/***************************************************************
 *  LoveTextForHer — BACKEND (PART 6 OF 7)
 *  ----------------------------------------------------------
 *  Includes:
 *      ✔ Resend email integration
 *      ✔ Universal email sender
 *      ✔ Customer cart
 *      ✔ One-time Stripe merch checkout
 *      ✔ Password reset system
 ***************************************************************/

/***************************************************************
 *  TWILIO SENDGRID EMAIL CLIENT
 ***************************************************************/
/***************************************************************
 *  BREVO EMAIL CLIENT
 ***************************************************************/
const brevo = require('@getbrevo/brevo');

let brevoClient = null;

if (process.env.BREVO_API_KEY) {
    const apiInstance = new brevo.TransactionalEmailsApi();
    const apiKey = apiInstance.authentications['apiKey'];
    apiKey.apiKey = process.env.BREVO_API_KEY;
    brevoClient = apiInstance;
    console.log("📧 Brevo email service loaded");
} else {
    console.warn("⚠️  BREVO_API_KEY not found - email disabled");
}

// Initialize SendGrid with API key
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    console.log("📧 SendGrid email service loaded");
} else {
    console.warn("⚠️  SENDGRID_API_KEY not found - email disabled");
}

/***************************************************************
 *  UNIVERSAL EMAIL SENDER (BREVO VERSION)
 ***************************************************************/
global.__LT_sendEmail = async function (to, subject, html, textVersion) {
    if (!brevoClient) {
        console.error("❌ Brevo not configured");
        return false;
    }

    try {
        console.log(`📧 Attempting to send email to ${to}`);
        console.log(`📧 From: ${process.env.FROM_EMAIL}`);
        
        const sendSmtpEmail = new brevo.SendSmtpEmail();
        
        sendSmtpEmail.sender = { 
            email: process.env.FROM_EMAIL,
            name: process.env.FROM_NAME || "LoveTextForHer"
        };
        
        sendSmtpEmail.to = [{ email: to }];
        sendSmtpEmail.subject = subject;
        sendSmtpEmail.htmlContent = html;
        sendSmtpEmail.textContent = textVersion || "";

        const result = await brevoClient.sendTransacEmail(sendSmtpEmail);
        
        console.log(`✅ Email sent successfully:`, result.messageId);
        return true;
        
    } catch (err) {
        console.error("❌ EMAIL SEND ERROR:", err);
        
        if (err.response) {
            console.error("❌ Brevo Error Response:", {
                statusCode: err.response.status,
                body: err.response.body
            });
        }
        
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
            return res.json({ success: true });
        }

        const filtered = (q.rows[0].items || []).filter(
            item => item.productId !== productId
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

        // ALWAYS act like success (security)
        if (!q.rows.length)
            return res.json({ success: true });

        const customerId = q.rows[0].id;

        // Invalidate older tokens
        await global.__LT_pool.query(
            `UPDATE password_reset_tokens SET used=true WHERE customer_id=$1`,
            [customerId]
        );

        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        await global.__LT_pool.query(
            `INSERT INTO password_reset_tokens (customer_id, token, expires_at)
             VALUES ($1,$2,$3)`,
            [customerId, token, expiresAt]
        );

        const resetURL =
            `${process.env.BASE_URL}/reset.html?token=${token}`;

        const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin:0;padding:0;font-family:Arial,sans-serif;background-color:#f5f5f5;">
        <div style="max-width:600px;margin:40px auto;background-color:white;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);">
            <div style="background-color:#d6336c;padding:30px;border-radius:8px 8px 0 0;text-align:center;">
                <h1 style="color:white;margin:0;font-size:28px;">LoveTextForHer</h1>
            </div>
            <div style="padding:40px 30px;">
                <h2 style="color:#333;margin-top:0;">Reset Your Password</h2>
                <p style="color:#666;font-size:16px;line-height:1.6;">
                    We received a request to reset your password. Click the button below to create a new password.
                </p>
                <div style="text-align:center;margin:30px 0;">
                    <a href="${resetURL}" 
                       style="display:inline-block;background-color:#d6336c;color:white;padding:15px 40px;text-decoration:none;border-radius:5px;font-size:16px;font-weight:bold;">
                        Reset My Password
                    </a>
                </div>
                <p style="color:#999;font-size:14px;line-height:1.6;">
                    This link will expire in 15 minutes. If you didn't request a password reset, you can safely ignore this email.
                </p>
                <hr style="border:none;border-top:1px solid #eee;margin:30px 0;">
                <p style="color:#999;font-size:12px;margin:0;">
                    Or copy and paste this link into your browser:<br>
                    <a href="${resetURL}" style="color:#d6336c;word-break:break-all;">${resetURL}</a>
                </p>
            </div>
        </div>
    </body>
    </html>
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

        if (new Date() > new Date(record.expires_at))
            return res.status(400).json({ error: "Token expired" });

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

        if (!items || !Array.isArray(items) || items.length === 0)
            return res.status(400).json({ error: "No items provided" });

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

        // clear cart after checkout session is created
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
 *  TWILIO SMS CLIENT
 ***************************************************************/
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    const twilio = require("twilio");
    twilioClient = twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
    );
    console.log("📱 Twilio SMS loaded");
}

/***************************************************************
 *  UNIVERSAL SMS SENDER
 ***************************************************************/
global.__LT_sendSMS = async function (to, message) {
    if (!twilioClient) {
        console.error("❌ Twilio not configured");
        return false;
    }
    
    try {
        await twilioClient.messages.create({
            body: message,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: to
        });
        console.log(`📱 SMS sent to ${to}`);
        return true;
    } catch (err) {
        console.error("❌ SMS SEND ERROR:", err);
        return false;
    }
};

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
function calculateNextDelivery(freq, timing, timezone) {
    // Use timezone-aware date library
    const now = new Date();
    const next = new Date(now);

    // TIME OF DAY (this is in UTC!)
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
 *  CRON JOB — AUTOMATIC MESSAGE SENDER (EVERY MINUTE)
 ***************************************************************/
cron.schedule("* * * * *", async () => {
    console.log("⏱  CRON: scanning for due messages…");

    const client = await global.__LT_pool.connect();

    try {
        const now = new Date();

        // Get all recipients due for a message
        const due = await client.query(`
            SELECT u.*, c.has_subscription, c.subscription_end
            FROM users u
            JOIN customers c ON u.customer_id = c.id
            WHERE u.is_active = true
              AND u.next_delivery <= $1
        `, [now]);

        for (const r of due.rows) {
            try {
                // Check if customer still has active subscription
                const isActive = r.has_subscription || 
                                (r.subscription_end && new Date(r.subscription_end) > now);
                
                if (!isActive) {
                    console.log(`⚠️  Skipping ${r.email} - subscription inactive`);
                    continue;
                }

                const message = global.__LT_buildMessage(r.name, r.relationship);
                
                // SEND EMAIL (if delivery method includes email)
                if (!r.delivery_method || r.delivery_method === "email" || r.delivery_method === "both") {
                    const unsubscribeURL = `${process.env.BASE_URL}/unsubscribe.html?token=${r.unsubscribe_token}`;
                    const html = global.__LT_buildLoveEmailHTML(r.name, message, unsubscribeURL);
                    
                    await global.__LT_sendEmail(
                        r.email,
                        "Your Love Message ❤️",
                        html,
                        message + "\n\nUnsubscribe: " + unsubscribeURL
                    );
                    
                    console.log(`💌 Email sent → ${r.email}`);
                }
                
                // SEND SMS (if delivery method includes SMS and phone exists)
                if ((r.delivery_method === "sms" || r.delivery_method === "both") && r.phone_number) {
                    const smsMessage = `${message}\n\nReply STOP to unsubscribe`;
                    await global.__LT_sendSMS(r.phone_number, smsMessage);
                    console.log(`📱 SMS sent → ${r.phone_number}`);
                }

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

                console.log(`💘 Love message sent → ${r.name}`);

            } catch (innerErr) {
                console.error("❌ Error sending automated message:", innerErr);
            }
        }

    } catch (err) {
        console.error("❌ CRON ERROR:", err);
    } finally {
        client.release();
    }
});

/***************************************************************
 *  COMPREHENSIVE KPI ENDPOINT FOR ADMIN DASHBOARD
 *  Add this to your backend (Part 5 or 6)
 ***************************************************************/

app.get("/api/admin/kpis", global.__LT_authAdmin, async (req, res) => {
    try {
        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();
        
        // Start of current month
        const monthStart = new Date(currentYear, currentMonth, 1);
        
        // Start of last month
        const lastMonthStart = new Date(currentYear, currentMonth - 1, 1);
        const lastMonthEnd = new Date(currentYear, currentMonth, 0, 23, 59, 59);

        /***********************************************************
         * 1. CUSTOMER METRICS
         ***********************************************************/
        const totalCustomers = await global.__LT_pool.query(
            `SELECT COUNT(*) FROM customers`
        );

        const activeSubscribers = await global.__LT_pool.query(
            `SELECT COUNT(*) FROM customers 
             WHERE has_subscription = true 
             OR (subscription_end IS NOT NULL AND subscription_end > $1)`,
            [now]
        );

        const newCustomersThisMonth = await global.__LT_pool.query(
            `SELECT COUNT(*) FROM customers 
             WHERE created_at >= $1`,
            [monthStart]
        );

        /***********************************************************
         * 2. SUBSCRIPTION BREAKDOWN BY PLAN
         ***********************************************************/
        const planBreakdown = await global.__LT_pool.query(
            `SELECT 
                current_plan,
                COUNT(*) as count
             FROM customers
             WHERE has_subscription = true
             OR (subscription_end IS NOT NULL AND subscription_end > $1)
             GROUP BY current_plan`,
            [now]
        );

        const planCounts = {
            trial: 0,
            basic: 0,
            plus: 0
        };

        planBreakdown.rows.forEach(row => {
            if (row.current_plan in planCounts) {
                planCounts[row.current_plan] = Number(row.count);
            }
        });

        /***********************************************************
         * 3. CANCELLATION METRICS
         ***********************************************************/
        const canceledButActive = await global.__LT_pool.query(
            `SELECT COUNT(*) FROM customers
             WHERE subscription_end IS NOT NULL 
             AND subscription_end > $1
             AND has_subscription = true`,
            [now]
        );

        const canceledThisMonth = await global.__LT_pool.query(
            `SELECT COUNT(*) FROM customers
             WHERE subscription_end >= $1 
             AND subscription_end IS NOT NULL`,
            [monthStart]
        );

        const canceledLastMonth = await global.__LT_pool.query(
            `SELECT COUNT(*) FROM customers
             WHERE subscription_end >= $1 
             AND subscription_end <= $2`,
            [lastMonthStart, lastMonthEnd]
        );

        /***********************************************************
         * 4. MONTHLY RECURRING REVENUE (MRR)
         ***********************************************************/
        // Pricing (update these to match your actual prices)
        const PRICES = {
            trial: 0,      // Free trial
            basic: 2.99,   // Update to your actual price
            plus: 7.99    // Update to your actual price
        };

        const currentMRR = 
            (planCounts.basic * PRICES.basic) +
            (planCounts.plus * PRICES.plus);

        const projectedMonthlyRevenue = currentMRR;

        // Calculate ARR (Annual Recurring Revenue)
        const currentARR = currentMRR * 12;

        /***********************************************************
         * 5. CHURN RATE CALCULATION
         ***********************************************************/
        const startOfLastMonthSubs = await global.__LT_pool.query(
            `SELECT COUNT(*) FROM customers
             WHERE (has_subscription = true OR subscription_end > $1)
             AND created_at < $2`,
            [lastMonthStart, lastMonthStart]
        );

        const lastMonthSubCount = Number(startOfLastMonthSubs.rows[0].count);
        const lastMonthChurned = Number(canceledLastMonth.rows[0].count);
        
        const churnRate = lastMonthSubCount > 0 
            ? (lastMonthChurned / lastMonthSubCount) * 100 
            : 0;

        /***********************************************************
         * 6. RECIPIENT METRICS
         ***********************************************************/
        const totalRecipients = await global.__LT_pool.query(
            `SELECT COUNT(*) FROM users`
        );

        const activeRecipients = await global.__LT_pool.query(
            `SELECT COUNT(*) FROM users WHERE is_active = true`
        );

        const recipientsAddedThisMonth = await global.__LT_pool.query(
            `SELECT COUNT(*) FROM users WHERE created_at >= $1`,
            [monthStart]
        );

        /***********************************************************
         * 7. MESSAGE METRICS
         ***********************************************************/
        const totalMessagesSent = await global.__LT_pool.query(
            `SELECT COUNT(*) FROM message_logs`
        );

        const messagesThisMonth = await global.__LT_pool.query(
            `SELECT COUNT(*) FROM message_logs WHERE sent_at >= $1`,
            [monthStart]
        );

        const messagesLastMonth = await global.__LT_pool.query(
            `SELECT COUNT(*) FROM message_logs 
             WHERE sent_at >= $1 AND sent_at <= $2`,
            [lastMonthStart, lastMonthEnd]
        );

        /***********************************************************
         * 8. GROWTH METRICS
         ***********************************************************/
        const lastMonthMRR = await calculateLastMonthMRR(lastMonthStart);
        
        const mrrGrowth = lastMonthMRR > 0 
            ? ((currentMRR - lastMonthMRR) / lastMonthMRR) * 100 
            : 0;

        /***********************************************************
         * 9. PROJECTED END-OF-MONTH REVENUE
         ***********************************************************/
        const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
        const currentDay = now.getDate();
        const daysRemaining = daysInMonth - currentDay;
        
        // Daily MRR rate
        const dailyMRR = currentMRR / daysInMonth;
        
        // Projected revenue for remaining days
        const projectedRemainingRevenue = dailyMRR * daysRemaining;
        
        // Already earned this month (prorated)
        const earnedSoFar = dailyMRR * currentDay;

        /***********************************************************
         * 10. CUSTOMER LIFETIME VALUE (LTV) ESTIMATE
         ***********************************************************/
        const avgCustomerLifespanMonths = churnRate > 0 
            ? 1 / (churnRate / 100) 
            : 12; // Default to 12 months if no churn

        const avgRevenuePerUser = Number(activeSubscribers.rows[0].count) > 0
            ? currentMRR / Number(activeSubscribers.rows[0].count)
            : 0;

        const estimatedLTV = avgRevenuePerUser * avgCustomerLifespanMonths;

        /***********************************************************
         * RETURN COMPREHENSIVE KPI OBJECT
         ***********************************************************/
        return res.json({
            // Core Metrics
            customers: {
                total: Number(totalCustomers.rows[0].count),
                activeSubscribers: Number(activeSubscribers.rows[0].count),
                newThisMonth: Number(newCustomersThisMonth.rows[0].count)
            },

            // Subscription Breakdown
            subscriptions: {
                trial: planCounts.trial,
                basic: planCounts.basic,
                plus: planCounts.plus,
                total: planCounts.trial + planCounts.basic + planCounts.plus
            },

            // Cancellation Metrics
            cancellations: {
                canceledButStillActive: Number(canceledButActive.rows[0].count),
                canceledThisMonth: Number(canceledThisMonth.rows[0].count),
                canceledLastMonth: Number(canceledLastMonth.rows[0].count)
            },

            // Revenue Metrics
            revenue: {
                currentMRR: currentMRR.toFixed(2),
                currentARR: currentARR.toFixed(2),
                lastMonthMRR: lastMonthMRR.toFixed(2),
                mrrGrowthPercent: mrrGrowth.toFixed(2),
                earnedThisMonth: earnedSoFar.toFixed(2),
                projectedEndOfMonth: (earnedSoFar + projectedRemainingRevenue).toFixed(2),
                avgRevenuePerUser: avgRevenuePerUser.toFixed(2)
            },

            // Churn & Retention
            churn: {
                monthlyChurnRate: churnRate.toFixed(2),
                estimatedLTV: estimatedLTV.toFixed(2),
                avgLifespanMonths: avgCustomerLifespanMonths.toFixed(1)
            },

            // Recipients
            recipients: {
                total: Number(totalRecipients.rows[0].count),
                active: Number(activeRecipients.rows[0].count),
                addedThisMonth: Number(recipientsAddedThisMonth.rows[0].count)
            },

            // Messages
            messages: {
                totalSent: Number(totalMessagesSent.rows[0].count),
                sentThisMonth: Number(messagesThisMonth.rows[0].count),
                sentLastMonth: Number(messagesLastMonth.rows[0].count)
            },

            // Date Context
            meta: {
                generatedAt: now.toISOString(),
                currentMonth: monthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
                daysIntoMonth: currentDay,
                daysRemainingInMonth: daysRemaining
            }
        });

    } catch (err) {
        console.error("KPI ERROR:", err);
        return res.status(500).json({ error: "Failed to calculate KPIs" });
    }
});

/***********************************************************
 * HELPER: CALCULATE LAST MONTH'S MRR
 ***********************************************************/
async function calculateLastMonthMRR(lastMonthStart) {
    const PRICES = {
        trial: 0,
        basic: 4.99,
        plus: 9.99
    };

    const lastMonthEnd = new Date(lastMonthStart);
    lastMonthEnd.setMonth(lastMonthEnd.getMonth() + 1);
    lastMonthEnd.setDate(0);
    lastMonthEnd.setHours(23, 59, 59);

    const lastMonthSubs = await global.__LT_pool.query(
        `SELECT 
            current_plan,
            COUNT(*) as count
         FROM customers
         WHERE (has_subscription = true OR subscription_end > $1)
         AND created_at < $2
         GROUP BY current_plan`,
        [lastMonthEnd, lastMonthEnd]
    );

    let lastMonthMRR = 0;
    lastMonthSubs.rows.forEach(row => {
        const price = PRICES[row.current_plan] || 0;
        lastMonthMRR += price * Number(row.count);
    });

    return lastMonthMRR;
}

/***************************************************************
 *  ADMIN — GET ALL CUSTOMERS
 ***************************************************************/
app.get("/api/admin/customers", global.__LT_authAdmin, async (req, res) => {
    try {
        const q = await global.__LT_pool.query(
            `SELECT 
                id, 
                email, 
                name, 
                has_subscription, 
                current_plan,
                stripe_customer_id,
                stripe_subscription_id,
                created_at
             FROM customers
             ORDER BY id DESC`
        );

        return res.json(q.rows);

    } catch (err) {
        console.error("ADMIN CUSTOMERS ERROR:", err);
        return res.status(500).json({ error: "Server error loading customers" });
    }
});

/***************************************************************
 *  ADMIN — DELETE CUSTOMER (and all their recipients)
 ***************************************************************/
app.delete("/api/admin/customer/:id", global.__LT_authAdmin, async (req, res) => {
    try {
        const customerId = req.params.id;

        // First delete all recipients for this customer
        await global.__LT_pool.query(
            "DELETE FROM users WHERE customer_id=$1",
            [customerId]
        );

        // Then delete the customer
        await global.__LT_pool.query(
            "DELETE FROM customers WHERE id=$1",
            [customerId]
        );

        return res.json({ success: true, deleted: customerId });

    } catch (err) {
        console.error("ADMIN DELETE CUSTOMER ERROR:", err);
        return res.status(500).json({ 
            success: false, 
            error: "Server error deleting customer" 
        });
    }
});

/***************************************************************
 *  ADMIN — SEND MARKETING EMAIL
 *  Sends to customers, recipients, or both
 ***************************************************************/
app.post("/api/admin/marketing/send", global.__LT_authAdmin, async (req, res) => {
    try {
        let { audience, subject, message } = req.body;

        // Validate inputs
        if (!audience || !subject || !message) {
            return res.status(400).json({ 
                error: "Audience, subject, and message are required" 
            });
        }

        subject = global.__LT_sanitize(subject);
        message = global.__LT_sanitize(message);

        if (!["customers", "recipients", "both"].includes(audience)) {
            return res.status(400).json({ 
                error: "Invalid audience. Must be 'customers', 'recipients', or 'both'" 
            });
        }

        let emailsSent = 0;
        let errors = 0;
        const emailList = [];

        // Get customer emails
        if (audience === "customers" || audience === "both") {
            const customersQ = await global.__LT_pool.query(
                `SELECT DISTINCT email, name FROM customers ORDER BY email`
            );
            
            for (const customer of customersQ.rows) {
                emailList.push({
                    email: customer.email,
                    name: customer.name,
                    type: 'customer'
                });
            }
        }

        // Get recipient emails
        if (audience === "recipients" || audience === "both") {
            const recipientsQ = await global.__LT_pool.query(
                `SELECT DISTINCT email, name FROM users WHERE is_active = true ORDER BY email`
            );
            
            for (const recipient of recipientsQ.rows) {
                // Avoid duplicates if sending to both
                if (!emailList.find(e => e.email === recipient.email)) {
                    emailList.push({
                        email: recipient.email,
                        name: recipient.name,
                        type: 'recipient'
                    });
                }
            }
        }

        // Send emails
        for (const contact of emailList) {
            try {
                const html = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    </head>
                    <body style="margin:0;padding:0;font-family:Arial,sans-serif;background-color:#f5f5f5;">
                        <div style="max-width:600px;margin:40px auto;background-color:white;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);">
                            <div style="background-color:#d6336c;padding:30px;border-radius:8px 8px 0 0;text-align:center;">
                                <h1 style="color:white;margin:0;font-size:28px;">LOVETEXTFORHER</h1>
                            </div>
                            <div style="padding:40px 30px;">
                                <h2 style="color:#333;margin-top:0;">Hello ${contact.name}!</h2>
                                <div style="font-size:16px;line-height:1.8;color:#333;white-space:pre-wrap;">
                                    ${message}
                                </div>
                                <hr style="border:none;border-top:1px solid #eee;margin:30px 0;">
                                <p style="color:#999;font-size:12px;text-align:center;margin:0;">
                                    This message was sent by LOVETEXTFORHER<br>
                                    <a href="${process.env.BASE_URL}" 
                                       style="color:#d6336c;text-decoration:none;">
                                        Visit our website
                                    </a>
                                </p>
                            </div>
                        </div>
                    </body>
                    </html>
                `;

                const sent = await global.__LT_sendEmail(
                    contact.email,
                    subject,
                    html,
                    message
                );

                if (sent) {
                    emailsSent++;
                    console.log(`📧 Marketing email sent to ${contact.email}`);
                } else {
                    errors++;
                    console.error(`❌ Failed to send to ${contact.email}`);
                }

                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));

            } catch (err) {
                errors++;
                console.error(`❌ Error sending to ${contact.email}:`, err);
            }
        }

        return res.json({
            success: true,
            sent: emailsSent,
            errors: errors,
            total: emailList.length,
            audience: audience
        });

    } catch (err) {
        console.error("❌ MARKETING EMAIL ERROR:", err);
        return res.status(500).json({ 
            error: "Server error sending marketing emails" 
        });
    }
});

/***************************************************************
 *  ADMIN — GET EMAIL COUNTS (for preview)
 ***************************************************************/
app.get("/api/admin/marketing/counts", global.__LT_authAdmin, async (req, res) => {
    try {
        const customersQ = await global.__LT_pool.query(
            `SELECT COUNT(DISTINCT email) FROM customers`
        );

        const recipientsQ = await global.__LT_pool.query(
            `SELECT COUNT(DISTINCT email) FROM users WHERE is_active = true`
        );

        // Count unique emails if sending to both
        const bothQ = await global.__LT_pool.query(`
            SELECT COUNT(*) FROM (
                SELECT email FROM customers
                UNION
                SELECT email FROM users WHERE is_active = true
            ) AS combined
        `);

        return res.json({
            customers: Number(customersQ.rows[0].count),
            recipients: Number(recipientsQ.rows[0].count),
            both: Number(bothQ.rows[0].count)
        });

    } catch (err) {
        console.error("❌ MARKETING COUNTS ERROR:", err);
        return res.status(500).json({ 
            error: "Server error getting email counts" 
        });
    }
});

/***************************************************************
 *  ADMIN — SEARCH MESSAGE LOGS BY CUSTOMER
 ***************************************************************/
app.get("/api/admin/message-logs/search", global.__LT_authAdmin, async (req, res) => {
    try {
        const query = req.query.query;

        if (!query) {
            return res.status(400).json({ error: "Search query required" });
        }

        // Try to find customer by email or ID
        let customer;
        
        // Check if query is a number (customer ID)
        if (!isNaN(query)) {
            const custQ = await global.__LT_pool.query(
                `SELECT id, email, name, has_subscription, current_plan, created_at
                 FROM customers WHERE id=$1`,
                [parseInt(query)]
            );
            customer = custQ.rows[0];
        }
        
        // If not found or not a number, search by email
        if (!customer) {
            const custQ = await global.__LT_pool.query(
                `SELECT id, email, name, has_subscription, current_plan, created_at
                 FROM customers WHERE email ILIKE $1`,
                [`%${query}%`]
            );
            customer = custQ.rows[0];
        }

        if (!customer) {
            return res.json({ customer: null, recipients: [], logs: [] });
        }

        // Get all recipients for this customer
        const recipientsQ = await global.__LT_pool.query(
            `SELECT id, email, name, relationship, is_active, created_at
             FROM users
             WHERE customer_id=$1
             ORDER BY id DESC`,
            [customer.id]
        );

        // Get all message logs for this customer
        const logsQ = await global.__LT_pool.query(
            `SELECT id, recipient_id, email, message, sent_at
             FROM message_logs
             WHERE customer_id=$1
             ORDER BY sent_at DESC`,
            [customer.id]
        );

        return res.json({
            customer: customer,
            recipients: recipientsQ.rows,
            logs: logsQ.rows
        });

    } catch (err) {
        console.error("ADMIN MESSAGE LOGS SEARCH ERROR:", err);
        return res.status(500).json({ error: "Server error searching message logs" });
    }
});

/***************************************************************
 *  FIX 3: ADD TRIAL CLEANUP CRON JOB (Add to Part 7)
 ***************************************************************/

// Run every hour to check for expired trials
cron.schedule("0 * * * *", async () => {
    console.log("⏱  CRON: Checking for expired trials...");

    try {
        const now = new Date();

        // Find trials that have expired
        const expiredTrials = await global.__LT_pool.query(`
            SELECT id, email, stripe_subscription_id
            FROM customers
            WHERE trial_active = true
              AND trial_end IS NOT NULL
              AND trial_end < $1
        `, [now]);

        for (const customer of expiredTrials.rows) {
            console.log(`⚠️  Trial expired for customer ${customer.id} (${customer.email})`);

            // Cancel the Stripe subscription
            if (customer.stripe_subscription_id && global.__LT_stripe) {
                try {
                    await global.__LT_stripe.subscriptions.cancel(
                        customer.stripe_subscription_id
                    );
                    console.log(`✅ Canceled Stripe subscription ${customer.stripe_subscription_id}`);
                } catch (err) {
                    console.error(`❌ Error canceling subscription:`, err);
                }
            }

            // Delete all recipients
            await global.__LT_pool.query(
                `DELETE FROM users WHERE customer_id = $1`,
                [customer.id]
            );

            // Update customer record
            await global.__LT_pool.query(`
                UPDATE customers
                SET 
                    has_subscription = false,
                    current_plan = 'none',
                    stripe_subscription_id = NULL,
                    trial_active = false,
                    trial_end = NULL
                WHERE id = $1
            `, [customer.id]);

            console.log(`🗑️  Trial cleanup complete for customer ${customer.id}`);
        }

        if (expiredTrials.rows.length > 0) {
            console.log(`✅ Cleaned up ${expiredTrials.rows.length} expired trial(s)`);
        }

    } catch (err) {
        console.error("❌ TRIAL CLEANUP ERROR:", err);
    }
});

/***************************************************************
 *  ADD THESE MISSING ENDPOINTS TO PART 6
 ***************************************************************/

// FIX 1: Add cart clear endpoint
app.post("/api/cart/clear", global.__LT_authCustomer, async (req, res) => {
    try {
        await global.__LT_pool.query(
            "UPDATE carts SET items='[]' WHERE customer_id=$1",
            [req.user.id]
        );
        return res.json({ success: true });
    } catch (err) {
        console.error("CART CLEAR ERROR:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

// FIX 2: Add password reset endpoints with correct paths
app.post("/api/reset/request", async (req, res) => {
    try {
        let { email } = req.body;
        email = global.__LT_sanitize(email);

        if (!email)
            return res.status(400).json({ error: "Email required" });

        const q = await global.__LT_pool.query(
            "SELECT id FROM customers WHERE email=$1",
            [email]
        );

        // ALWAYS act like success (security)
        if (!q.rows.length)
            return res.json({ success: true });

        const customerId = q.rows[0].id;

        // Invalidate older tokens
        await global.__LT_pool.query(
            `UPDATE password_reset_tokens SET used=true WHERE customer_id=$1`,
            [customerId]
        );

        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        await global.__LT_pool.query(
            `INSERT INTO password_reset_tokens (customer_id, token, expires_at)
             VALUES ($1,$2,$3)`,
            [customerId, token, expiresAt]
        );

        const resetURL =
            `${process.env.BASE_URL}/reset.html?token=${token}`;

        const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin:0;padding:0;font-family:Arial,sans-serif;background-color:#f5f5f5;">
        <div style="max-width:600px;margin:40px auto;background-color:white;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);">
            <div style="background-color:#d6336c;padding:30px;border-radius:8px 8px 0 0;text-align:center;">
                <h1 style="color:white;margin:0;font-size:28px;">LOVETEXTFORHER</h1>
            </div>
            <div style="padding:40px 30px;">
                <h2 style="color:#333;margin-top:0;">Reset Your Password</h2>
                <p style="color:#666;font-size:16px;line-height:1.6;">
                    We received a request to reset your password. Click the button below to create a new password.
                </p>
                <div style="text-align:center;margin:30px 0;">
                    <a href="${resetURL}" 
                       style="display:inline-block;background-color:#d6336c;color:white;padding:15px 40px;text-decoration:none;border-radius:5px;font-size:16px;font-weight:bold;">
                        Reset My Password
                    </a>
                </div>
                <p style="color:#999;font-size:14px;line-height:1.6;">
                    This link will expire in 15 minutes. If you didn't request a password reset, you can safely ignore this email.
                </p>
                <hr style="border:none;border-top:1px solid #eee;margin:30px 0;">
                <p style="color:#999;font-size:12px;margin:0;">
                    Or copy and paste this link into your browser:<br>
                    <a href="${resetURL}" style="color:#d6336c;word-break:break-all;">${resetURL}</a>
                </p>
            </div>
        </div>
    </body>
    </html>
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

app.post("/api/reset/confirm", async (req, res) => {
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

        if (new Date() > new Date(record.expires_at))
            return res.status(400).json({ error: "Token expired" });

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
 *  FRONTEND STATIC FILES (REQUIRED FOR RENDER)
 ***************************************************************/
const publicDir = path.join(__dirname, "public");

// Serve static assets
app.use(express.static(publicDir));

// Serve homepage
app.get("/", (req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
});

// Serve all other frontend pages (SPA-style fallback)
app.get("*", (req, res) => {
    // If it's an API route, let Express handle 404
    if (req.path.startsWith("/api")) {
        return res.status(404).json({ error: "API route not found" });
    }

    res.sendFile(path.join(publicDir, "index.html"));
});


/***************************************************************
 *  TWILIO SMS WEBHOOK - HANDLE INCOMING STOP MESSAGES
 *  Place this BEFORE app.listen() at the end of your server.js
 ***************************************************************/
app.post("/api/twilio/sms-webhook", express.urlencoded({ extended: false }), async (req, res) => {
    try {
        const { From, Body } = req.body;
        const message = Body?.trim().toUpperCase();
        
        console.log(`📱 Incoming SMS from ${From}: "${Body}"`);
        
        const stopKeywords = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];
        
        if (stopKeywords.includes(message)) {
            // DELETE recipient by phone number instead of just deactivating
            const result = await global.__LT_pool.query(
                `DELETE FROM users WHERE phone_number = $1 RETURNING id, name`,
                [From]
            );
            
            if (result.rows.length > 0) {
                console.log(`🗑️  Recipient unsubscribed via SMS and deleted: ${result.rows[0].name} (${From})`);
            } else {
                console.log(`⚠️  No recipient found for ${From}`);
            }
        }
        
        res.type('text/xml');
        return res.send('<Response></Response>');
        
    } catch (err) {
        console.error("❌ SMS WEBHOOK ERROR:", err);
        res.type('text/xml');
        return res.send('<Response></Response>');
    }
});

/***************************************************************
 *  RECORD TERMS AGREEMENT
 ***************************************************************/
app.post("/api/customer/terms/agree", global.__LT_authCustomer, async (req, res) => {
    try {
        const { recipientEmail, recipientName } = req.body;
        
        if (!recipientEmail || !recipientName) {
            return res.status(400).json({ error: "Recipient information required" });
        }

        const ipAddress = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                         req.connection.remoteAddress || 
                         req.socket.remoteAddress ||
                         'unknown';
        
        const userAgent = req.headers['user-agent'] || 'unknown';

        await global.__LT_pool.query(
            `INSERT INTO recipient_terms_agreements 
             (customer_id, recipient_email, recipient_name, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (customer_id, recipient_email) 
             DO UPDATE SET 
                agreed_at = CURRENT_TIMESTAMP,
                ip_address = $4,
                user_agent = $5,
                recipient_name = $3`,
            [req.user.id, recipientEmail, recipientName, ipAddress, userAgent]
        );

        console.log(`✅ Terms agreement recorded for ${recipientEmail}`);
        return res.json({ success: true });

    } catch (err) {
        console.error("❌ TERMS AGREEMENT ERROR:", err);
        return res.status(500).json({ error: "Error recording agreement" });
    }
});

/***************************************************************
 *  CHECK IF TERMS AGREED FOR RECIPIENT
 ***************************************************************/
app.get("/api/customer/terms/check/:email", global.__LT_authCustomer, async (req, res) => {
    try {
        const email = req.params.email;
        
        const q = await global.__LT_pool.query(
            `SELECT agreed_at FROM recipient_terms_agreements
             WHERE customer_id = $1 AND recipient_email = $2`,
            [req.user.id, email]
        );

        return res.json({ 
            agreed: q.rows.length > 0,
            agreedAt: q.rows[0]?.agreed_at || null
        });

    } catch (err) {
        console.error("❌ TERMS CHECK ERROR:", err);
        return res.status(500).json({ error: "Error checking agreement" });
    }
});

/***************************************************************
 *  SERVER START
 ***************************************************************/
app.listen(PORT, () => {
    console.log(`🚀 LoveTextForHer Backend Running on Port ${PORT}`);
    console.log(`📱 SMS webhook ready at: https://lovetextforher-backend.onrender.com/api/twilio/sms-webhook`);
});

/***************************************************************
 *  BACKEND COMPLETE
 *  
 *  NEXT STEPS:
 *  1. Deploy this updated server
 *  2. Configure Twilio webhook:
 *     - URL: https://yourdomain.com/api/twilio/sms-webhook
 *     - Method: POST
 *  3. Test by texting STOP to your Twilio number
 ***************************************************************/