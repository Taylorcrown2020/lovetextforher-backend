/***************************************************************
 *  LoveTextForHer — CLEAN BACKEND REBUILD (2025)
 *  PART 1 OF 7 — SYSTEM + STRIPE + WEBHOOK
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

/***************************************************************
 *  INITIALIZE EXPRESS
 ***************************************************************/
const app = express();
const PORT = process.env.PORT || 3000;

/***************************************************************
 *  INITIALIZE STRIPE FIRST (ABSOLUTE REQUIREMENT)
 ***************************************************************/
let stripe = null;

if (process.env.STRIPE_SECRET_KEY) {
    stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    console.log("⚡ Stripe Loaded");
} else {
    console.log("⚠️ Stripe NOT loaded — Missing STRIPE_SECRET_KEY");
}

global.__LT_stripe = stripe;

/***************************************************************
 *  STRIPE PRICE MAP (SAFE & CLEAN)
 ***************************************************************/
global.__LT_prices = {
    "free-trial": process.env.STRIPE_FREETRIAL_PRICE_ID,
    "love-basic": process.env.STRIPE_BASIC_PRICE_ID,
    "love-plus": process.env.STRIPE_PLUS_PRICE_ID
};

console.log("💰 PRICE MAP:", global.__LT_prices);

/***************************************************************
 *  RAW WEBHOOK — MUST COME BEFORE JSON BODY PARSER
 ***************************************************************/
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    try {
        if (!global.__LT_stripe) {
            console.log("❌ STRIPE NOT INITIALIZED");
            return res.sendStatus(200);
        }

        const signature = req.headers["stripe-signature"];

        let event;
        try {
            event = global.__LT_stripe.webhooks.constructEvent(
                req.body,
                signature,
                process.env.STRIPE_WEBHOOK_SECRET
            );
        } catch (err) {
            console.error("❌ WEBHOOK SIGNATURE ERROR:", err.message);
            return res.status(400).send(`Webhook error: ${err.message}`);
        }

        const data = event.data.object;
        const type = event.type;

        console.log("📩 Webhook received:", type);

        /***********************************************************
         * Helper: Map Stripe price → internal plan name
         ***********************************************************/
        function mapPrice(priceId) {
            const p = global.__LT_prices;
            if (priceId === p["free-trial"]) return "trial";
            if (priceId === p["love-basic"]) return "basic";
            if (priceId === p["love-plus"]) return "plus";
            return "none";
        }

        /***********************************************************
         * CHECKOUT SESSION COMPLETED — NEW SUB
         ***********************************************************/
        if (type === "checkout.session.completed") {
            const customerId = data.metadata?.customer_id;

            if (data.mode === "subscription" && customerId) {
                const subscription = await stripe.subscriptions.retrieve(data.subscription);
                const priceId = subscription.items.data[0].price.id;
                const plan = mapPrice(priceId);

                console.log(`🟢 Checkout Completed → Customer #${customerId} → ${plan}`);

                await global.__LT_pool.query(
                    `UPDATE customers SET
                        has_subscription = TRUE,
                        current_plan = $1,
                        stripe_subscription_id = $2,
                        subscription_end = NULL
                     WHERE id = $3`,
                    [plan, data.subscription, customerId]
                );
            }
        }

        /***********************************************************
         * SUBSCRIPTION CREATED
         ***********************************************************/
        if (type === "customer.subscription.created") {
            const priceId = data.items.data[0].price.id;
            const plan = mapPrice(priceId);

            await global.__LT_pool.query(
                `UPDATE customers SET
                    has_subscription = TRUE,
                    current_plan = $1,
                    stripe_subscription_id = $2,
                    subscription_end = NULL
                 WHERE stripe_customer_id = $3`,
                [plan, data.id, data.customer]
            );

            console.log("➕ Subscription created:", plan);
        }

        /***********************************************************
         * SUBSCRIPTION UPDATED
         ***********************************************************/
        if (type === "customer.subscription.updated") {
            const priceId = data.items.data[0].price.id;
            const plan = mapPrice(priceId);

            if (data.status === "active" || data.status === "trialing") {
                await global.__LT_pool.query(
                    `UPDATE customers SET
                        has_subscription = TRUE,
                        current_plan = $1
                     WHERE stripe_customer_id = $2`,
                    [plan, data.customer]
                );

                console.log("🔄 Subscription updated:", plan);
            }
        }

        /***********************************************************
         * SUBSCRIPTION DELETED
         ***********************************************************/
        if (type === "customer.subscription.deleted") {
            await global.__LT_pool.query(
                `UPDATE customers SET
                    has_subscription = FALSE,
                    current_plan = 'none',
                    stripe_subscription_id = NULL,
                    subscription_end = NOW()
                 WHERE stripe_customer_id = $1`,
                [data.customer]
            );

            console.log("❌ Subscription canceled");
        }

        return res.sendStatus(200);

    } catch (err) {
        console.error("❌ WEBHOOK FATAL ERROR:", err);
        return res.status(500).send("Webhook server error");
    }
});
/***************************************************************
 *  PART 2 OF 7 — BODY PARSERS, CORS, DB, HELPERS, AUTH
 ***************************************************************/

/***************************************************************
 *  BODY PARSERS (IMPORTANT — AFTER WEBHOOK)
 ***************************************************************/
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

/***************************************************************
 *  CORS — SUPPORT RENDER FRONTEND + LOCAL DEV
 ***************************************************************/
app.use(
    cors({
        origin: process.env.FRONTEND_URL,
        credentials: true
    })
);

/***************************************************************
 *  STATIC FILES (Serve public folder)
 ***************************************************************/
app.use(express.static(path.join(__dirname, "public")));

/***************************************************************
 *  POSTGRES DATABASE (Render PostgreSQL)
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
    .then(() => console.log("📦 Database connected"))
    .catch(err => console.error("❌ DATABASE ERROR:", err));

global.__LT_pool = pool;

/***************************************************************
 *  SANITIZER (Blocks HTML injection + weird characters)
 ***************************************************************/
function sanitize(str) {
    if (!str || typeof str !== "string") return str;
    return str.replace(/[<>'"]/g, "");
}
global.__LT_sanitize = sanitize;

/***************************************************************
 *  JWT TOKEN GENERATOR
 ***************************************************************/
function generateToken(payload) {
    return jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: "7d"
    });
}
global.__LT_generateToken = generateToken;

/***************************************************************
 *  CUSTOMER AUTH MIDDLEWARE
 ***************************************************************/
global.__LT_authCustomer = function (req, res, next) {
    try {
        const token = req.cookies.customer_token;
        if (!token) return res.status(401).json({ error: "Not logged in" });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role !== "customer") throw new Error("Not customer");

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
        if (!token) return res.status(401).json({ error: "Not logged in" });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role !== "admin") throw new Error("Not admin");

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
 *  PLAN NORMALIZER + LIMITS (Used by subscription handlers)
 ***************************************************************/
function normalizePlan(productId) {
    if (productId === "free-trial") return "trial";
    if (productId === "love-basic") return "basic";
    if (productId === "love-plus") return "plus";
    return "none";
}
global.__LT_normalizePlan = normalizePlan;

function getRecipientLimit(plan) {
    if (plan === "plus") return Infinity;
    if (plan === "trial") return Infinity;
    if (plan === "basic") return 3;
    return 0;
}
global.__LT_getRecipientLimit = getRecipientLimit;
/***************************************************************
 *  PART 3 OF 7 — CUSTOMER + ADMIN AUTH FLOWS
 ***************************************************************/

/***************************************************************
 *  CUSTOMER REGISTRATION
 ***************************************************************/
app.post("/api/customer/register", async (req, res) => {
    try {
        let { email, password, name } = req.body;

        email = global.__LT_sanitize(email);
        name = global.__LT_sanitize(name);

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
                 trial_active, trial_end,
                 stripe_customer_id, stripe_subscription_id,
                 subscription_end)
             VALUES ($1,$2,$3,false,'none',false,NULL,NULL,NULL,NULL)`,
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
 *  ADMIN — /me (verify admin identity)
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
 *  CUSTOMER — /me (verify customer identity)
 ***************************************************************/
app.get("/api/customer/me", global.__LT_authCustomer, async (req, res) => {
    try {
        const q = await global.__LT_pool.query(
            "SELECT id, email, name, has_subscription, current_plan FROM customers WHERE id=$1",
            [req.user.id]
        );

        if (!q.rows.length)
            return res.json({ customer: null });

        return res.json({ customer: q.rows[0] });

    } catch (err) {
        console.error("CUSTOMER /me ERROR:", err);
        return res.status(500).json({ customer: null });
    }
});
/***************************************************************
 *  PART 4 OF 7 — STRIPE SUBSCRIPTIONS (FULL SYSTEM)
 ***************************************************************/

/***************************************************************
 *  HELPER — GET CUSTOMER RECORD
 ***************************************************************/
async function getCustomerRecord(id) {
    const q = await global.__LT_pool.query(
        "SELECT * FROM customers WHERE id=$1",
        [id]
    );
    return q.rows[0] || null;
}

/***************************************************************
 *  HELPER — ENSURE STRIPE CUSTOMER EXISTS
 ***************************************************************/
async function ensureStripeCustomer(customer) {
    if (customer.stripe_customer_id) return customer.stripe_customer_id;

    const created = await global.__LT_stripe.customers.create({
        email: customer.email,
        metadata: { customer_id: customer.id }
    });

    await global.__LT_pool.query(
        "UPDATE customers SET stripe_customer_id=$1 WHERE id=$2",
        [created.id, customer.id]
    );

    return created.id;
}

/***************************************************************
 *  GET SUBSCRIPTION STATUS
 ***************************************************************/
app.get(
    "/api/customer/subscription",
    global.__LT_authCustomer,
    async (req, res) => {
        try {
            const q = await global.__LT_pool.query(
                `SELECT 
                    has_subscription,
                    current_plan,
                    trial_active,
                    trial_end,
                    stripe_subscription_id,
                    subscription_end
                 FROM customers
                 WHERE id=$1`,
                [req.user.id]
            );

            if (!q.rows.length)
                return res.status(404).json({ error: "Customer not found" });

            const c = q.rows[0];
            let subscribed = false;

            // Database says active
            if (c.has_subscription) subscribed = true;

            // Grace period after cancellation
            if (c.subscription_end &&
                new Date(c.subscription_end) > new Date()) {
                subscribed = true;
            }

            return res.json({
                has_subscription: c.has_subscription,
                subscribed,
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
    }
);

/***************************************************************
 *  STRIPE CHECKOUT — NEW SUB / UPGRADE / DOWNGRADE
 ***************************************************************/
app.post(
    "/api/stripe/checkout",
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
                } catch {}
            }

            /***********************************************************
             * TRIAL GUARD — Only one trial ever
             ***********************************************************/
            if (newPlan === "trial" && customer.has_subscription === true) {
                return res.status(400).json({
                    error: "You already used your free trial."
                });
            }

            /***********************************************************
             * CASE 1 — ACTIVE SUBSCRIPTION → CHANGE PLAN
             ***********************************************************/
            if (stripeSub && stripeSub.status !== "canceled") {

                const itemId = stripeSub.items.data[0].id;

                // Update Stripe subscription
                await global.__LT_stripe.subscriptions.update(
                    stripeSub.id,
                    {
                        cancel_at_period_end: false,
                        proration_behavior: "always_invoice",
                        items: [{ id: itemId, price: priceId }]
                    }
                );

                // Update DB
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
             * CASE 2 — NO ACTIVE SUB → CREATE NEW CHECKOUT SESSION
             ***********************************************************/
            const session = await global.__LT_stripe.checkout.sessions.create({
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
    }
);

/***************************************************************
 *  CANCEL SUBSCRIPTION
 ***************************************************************/
app.post(
    "/api/customer/subscription/cancel",
    global.__LT_authCustomer,
    async (req, res) => {
        try {
            const q = await global.__LT_pool.query(
                "SELECT stripe_subscription_id FROM customers WHERE id=$1",
                [req.user.id]
            );

            if (!q.rows.length || !q.rows[0].stripe_subscription_id)
                return res.status(400).json({ error: "No active subscription" });

            const subId = q.rows[0].stripe_subscription_id;

            await global.__LT_stripe.subscriptions.update(subId, {
                cancel_at_period_end: true
            });

            return res.json({
                success: true,
                message: "Subscription will cancel at the end of your billing period."
            });

        } catch (err) {
            console.error("CANCEL ERROR:", err);
            return res.status(500).json({ error: "Cancel failed" });
        }
    }
);

/***************************************************************
 *  BILLING PORTAL
 ***************************************************************/
app.get(
    "/api/customer/subscription/portal",
    global.__LT_authCustomer,
    async (req, res) => {
        try {
            const q = await global.__LT_pool.query(
                "SELECT stripe_customer_id FROM customers WHERE id=$1",
                [req.user.id]
            );

            if (!q.rows.length || !q.rows[0].stripe_customer_id)
                return res.status(400).json({ error: "Stripe customer missing" });

            const portal =
                await global.__LT_stripe.billingPortal.sessions.create({
                    customer: q.rows[0].stripe_customer_id,
                    return_url: `${process.env.BASE_URL}/dashboard.html`
                });

            return res.json({ url: portal.url });

        } catch (err) {
            console.error("PORTAL ERROR:", err);
            return res.status(500).json({ error: "Billing portal error" });
        }
    }
);
/***************************************************************
 *  PART 5 OF 7 — RECIPIENTS + LIMITS + LOGGING + FLOWERS
 ***************************************************************/

/***************************************************************
 *  HELPER — COUNT RECIPIENTS FOR CUSTOMER
 ***************************************************************/
async function countRecipients(customerId) {
    const q = await global.__LT_pool.query(
        "SELECT COUNT(*) FROM users WHERE customer_id=$1",
        [customerId]
    );
    return Number(q.rows[0].count);
}

/***************************************************************
 *  HELPER — SAVE MESSAGE TO LOGS
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
 *  GET CUSTOMER RECIPIENTS
 ***************************************************************/
app.get(
    "/api/customer/recipients",
    global.__LT_authCustomer,
    async (req, res) => {
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
    }
);

/***************************************************************
 *  ADD RECIPIENT — ENFORCES SUBSCRIPTION PLAN LIMITS
 ***************************************************************/
app.post(
    "/api/customer/recipients",
    global.__LT_authCustomer,
    async (req, res) => {
        try {
            const customerQ = await global.__LT_pool.query(
                "SELECT * FROM customers WHERE id=$1",
                [req.user.id]
            );

            if (!customerQ.rows.length)
                return res.status(404).json({ error: "Customer not found" });

            const customer = customerQ.rows[0];

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
                    email,
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
    }
);

/***************************************************************
 *  DELETE RECIPIENT
 ***************************************************************/
app.delete(
    "/api/customer/recipients/:id",
    global.__LT_authCustomer,
    async (req, res) => {
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
    }
);

/***************************************************************
 *  GET MESSAGE LOGS (LAST 5)
 ***************************************************************/
app.get(
    "/api/message-log/:recipientId",
    global.__LT_authCustomer,
    async (req, res) => {
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
    }
);

/***************************************************************
 *  SEND A FLOWER 🌸
 ***************************************************************/
app.post(
    "/api/customer/send-flowers/:id",
    global.__LT_authCustomer,
    async (req, res) => {
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

            const message =
                `🌸 A flower for you!` +
                (note?.trim()
                    ? ` — ${global.__LT_sanitize(note.trim())}`
                    : "");

            const html =
                global.__LT_buildLoveEmailHTML(
                    r.name,
                    message,
                    unsubscribeURL
                );

            await global.__LT_sendEmail(
                r.email,
                "You received a flower 🌸",
                html,
                message + "\n\nUnsubscribe: " + unsubscribeURL
            );

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
    }
);

/***************************************************************
 *  PUBLIC UNSUBSCRIBE
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

        await global.__LT_pool.query(
            "UPDATE users SET is_active=false WHERE id=$1",
            [q.rows[0].id]
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
 *  PART 6 OF 7 — CART, MERCH CHECKOUT, PASSWORD RESET, EMAIL
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
app.get(
    "/api/cart",
    global.__LT_authCustomer,
    async (req, res) => {
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
    }
);

/***************************************************************
 *  ADD ITEM TO CART
 ***************************************************************/
app.post(
    "/api/cart/add",
    global.__LT_authCustomer,
    async (req, res) => {
        try {
            let { productId, name, price } = req.body;

            productId = global.__LT_sanitize(productId);
            name = global.__LT_sanitize(name);

            price = Number(price);
            if (!productId || !name || isNaN(price) || price <= 0) {
                return res.status(400).json({ error: "Invalid product" });
            }

            const existing = await global.__LT_pool.query(
                "SELECT items FROM carts WHERE customer_id=$1",
                [req.user.id]
            );

            const items = existing.rows.length
                ? existing.rows[0].items || []
                : [];

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
    }
);

/***************************************************************
 *  REMOVE ITEM FROM CART
 ***************************************************************/
app.post(
    "/api/cart/remove",
    global.__LT_authCustomer,
    async (req, res) => {
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
    }
);

/***************************************************************
 *  MERCH CHECKOUT — ONE-TIME PAYMENT
 ***************************************************************/
app.post(
    "/api/stripe/merch-checkout",
    global.__LT_authCustomer,
    async (req, res) => {
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

            // Empty the cart after creating checkout session
            await global.__LT_pool.query(
                "UPDATE carts SET items='[]' WHERE customer_id=$1",
                [req.user.id]
            );

            return res.json({ url: session.url });

        } catch (err) {
            console.error("❌ MERCH CHECKOUT ERROR:", err);
            return res.status(500).json({
                error: "Server error processing merch checkout"
            });
        }
    }
);

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

        // Always return success to prevent email enumeration
        if (!q.rows.length)
            return res.json({ success: true });

        const customerId = q.rows[0].id;

        // Invalidate previous tokens
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

        const resetURL =
            `${process.env.BASE_URL}/reset_password.html?token=${token}`;

        const html = `
            <div style="font-family:Arial;padding:20px;">
                <h2>Password Reset Request</h2>
                <p>Click below to reset your password (15 min expiration).</p>
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
 *  PASSWORD RESET — FINALIZE PASSWORD CHANGE
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
 *  PART 7 OF 7 — CRON JOB, AUTO-SENDER, SERVER START
 ***************************************************************/

/***************************************************************
 *  NEXT DELIVERY TIME CALCULATOR
 ***************************************************************/
function calculateNextDelivery(freq, timing) {
    const now = new Date();
    const next = new Date(now);

    // --- Set the delivery time of day ---
    switch (timing) {
        case "morning":     next.setHours(9, 0, 0); break;
        case "afternoon":   next.setHours(13, 0, 0); break;
        case "evening":     next.setHours(18, 0, 0); break;
        case "night":       next.setHours(22, 0, 0); break;
        default:            next.setHours(12, 0, 0);
    }

    // --- Set the delivery frequency ---
    switch (freq) {
        case "daily":             next.setDate(now.getDate() + 1); break;
        case "every-other-day":   next.setDate(now.getDate() + 2); break;
        case "three-times-week":  next.setDate(now.getDate() + 2); break;
        case "weekly":            next.setDate(now.getDate() + 7); break;
        case "bi-weekly":         next.setDate(now.getDate() + 14); break;
        default:                  next.setDate(now.getDate() + 1);
    }

    return next;
}

/***************************************************************
 *  CRON JOB — AUTO MESSAGE SENDER (EVERY MINUTE)
 ***************************************************************/
cron.schedule("* * * * *", async () => {
    console.log("⏱  CRON: scanning for due messages…");

    const client = await global.__LT_pool.connect();

    try {
        const now = new Date();

        // Find all recipients whose next delivery is due
        const due = await client.query(
            `
            SELECT *
            FROM users
            WHERE is_active = TRUE
              AND next_delivery <= $1
            `,
            [now]
        );

        for (const r of due.rows) {
            console.log("💌 Sending scheduled message to:", r.email);

            try {
                // Build unsubscribe URL
                const unsubscribeURL =
                    `${process.env.BASE_URL}/unsubscribe.html?token=${r.unsubscribe_token}`;

                // Build the love message
                const message =
                    global.__LT_buildMessage(r.name, r.relationship);

                // Build the HTML
                const html =
                    global.__LT_buildLoveEmailHTML(
                        r.name,
                        message,
                        unsubscribeURL
                    );

                // Send the email
                await global.__LT_sendEmail(
                    r.email,
                    "Your Love Message ❤️",
                    html,
                    message + "\n\nUnsubscribe: " + unsubscribeURL
                );

                // Log the message in the DB
                await global.__LT_logMessage(
                    r.customer_id,
                    r.id,
                    r.email,
                    message
                );

                // Calculate and update next delivery time
                const next = calculateNextDelivery(r.frequency, r.timings);

                await client.query(
                    `
                    UPDATE users
                    SET next_delivery=$1,
                        last_sent=NOW()
                    WHERE id=$2
                    `,
                    [next, r.id]
                );

                console.log(`💘 Love message sent → ${r.email}`);

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