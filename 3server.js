process.env.TZ = "UTC";

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET missing in environment!");
}

// --------------------------------------------------
// STRIPE SETUP
// --------------------------------------------------
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
    stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    console.log("⚡ Stripe loaded");
} else {
    console.log("⚠️ STRIPE_SECRET_KEY not set — Stripe disabled");
}

// ============================================================
// STRIPE WEBHOOK HANDLER (must be BEFORE express.json())
// ============================================================
if (stripe) {
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
                console.error("❌ Webhook signature error:", err.message);
                return res.status(400).send(`Webhook Error: ${err.message}`);
            }

            console.log("✅ Stripe Webhook Event Received:", event.type);

            try {
                switch (event.type) {
                    case "checkout.session.completed": {
                        const session = event.data.object;
                        const customerId = session.client_reference_id; // our customer.id
                        const stripeCustomerId = session.customer;
                        const subscriptionId = session.subscription;

                        console.log("🎉 Subscription purchased for customer:", customerId);

                        await pool.query(
                            `
                            UPDATE customers
                            SET has_subscription = true,
                                stripe_customer_id = $1,
                                subscription_id = $2
                            WHERE id = $3
                        `,
                            [stripeCustomerId, subscriptionId, customerId]
                        );
                        break;
                    }

                    case "customer.subscription.deleted": {
                        const subscription = event.data.object;
                        const stripeCustomerId = subscription.customer;

                        console.log("❌ Subscription canceled for:", stripeCustomerId);

                        await pool.query(
                            `
                            UPDATE customers
                            SET has_subscription = false
                            WHERE stripe_customer_id = $1
                        `,
                            [stripeCustomerId]
                        );
                        break;
                    }

                    default:
                        // ignore other events for now
                        break;
                }

                res.json({ received: true });
            } catch (err) {
                console.error("❌ Webhook handler error:", err);
                res.status(500).send("Webhook handler error");
            }
        }
    );
}


// ============================================================
// STRIPE WEBHOOK HANDLER — FINAL VERSION
// ============================================================
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

        console.log("⚡ Stripe Event:", event.type);

        // -------------------------
        // 1. CHECKOUT SUCCESS
        // -------------------------
        if (event.type === "checkout.session.completed") {
            const session = event.data.object;

            const stripeCustomerId = session.customer;

            console.log("🎉 Checkout Completed for Stripe Customer:", stripeCustomerId);

            // Lookup local customer by stripeCustomerId
            const lookup = await pool.query(
                "SELECT id FROM customers WHERE stripe_customer_id=$1",
                [stripeCustomerId]
            );

            // If customer not found yet — create mapping
            if (lookup.rows.length === 0) {
                const email = session.customer_details.email;

                const user = await pool.query(
                    "SELECT id FROM customers WHERE email=$1",
                    [email]
                );

                if (user.rows.length > 0) {
                    await pool.query(
                        "UPDATE customers SET stripe_customer_id=$1 WHERE id=$2",
                        [stripeCustomerId, user.rows[0].id]
                    );

                    console.log("🔗 Linked Stripe customer to DB user:", user.rows[0].id);
                }
            }

            // Mark subscription as active
            await pool.query(
                "UPDATE customers SET has_subscription=true WHERE stripe_customer_id=$1",
                [stripeCustomerId]
            );

            console.log("✅ Subscription activated in database.");

            return res.json({ received: true });
        }

        // -------------------------
        // 2. SUBSCRIPTION CANCELED
        // -------------------------
        if (event.type === "customer.subscription.deleted") {
            const subscription = event.data.object;
            const stripeCustomerId = subscription.customer;

            console.log("❌ Subscription canceled for:", stripeCustomerId);

            await pool.query(
                "UPDATE customers SET has_subscription=false WHERE stripe_customer_id=$1",
                [stripeCustomerId]
            );

            return res.json({ received: true });
        }

        // Default
        res.json({ received: true });
    }
);
// --------------------------------------------------
// MIDDLEWARES (after webhook)
// --------------------------------------------------
app.use(
    cors({
        origin: [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:5500",
            "http://127.0.0.1:5500",
        ],
        credentials: true,
    })
);

app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

// --------------------------------------------------
// DATABASE
// --------------------------------------------------
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
});

pool
    .query("SELECT NOW()")
    .then(() => console.log("✅ DB CONNECTED"))
    .catch((err) => console.error("❌ DB ERROR:", err));

// --------------------------------------------------
// EMAIL TRANSPORT
// --------------------------------------------------
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

transporter.verify((err) => {
    if (err) console.error("❌ SMTP ERROR:", err);
    else console.log("📨 SMTP READY");
});

async function sendEmail(to, subject, html, text = "") {
    try {
        await transporter.sendMail({
            from: process.env.FROM_EMAIL,
            to,
            subject,
            html,
            text: text || html.replace(/<[^>]+>/g, ""),
        });
        console.log("📤 EMAIL SENT →", to);
    } catch (err) {
        console.error("❌ EMAIL SEND ERROR:", err);
    }
}

// --------------------------------------------------
// TEMPLATE
// --------------------------------------------------
function buildLoveEmailHTML(name, message, unsubscribeLink) {
    return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
body { background:#fdf2f8;font-family:Arial;padding:0;margin:0;}
.container {max-width:480px;margin:auto;background:white;border-radius:12px;padding:25px;}
.header {font-size:22px;font-weight:bold;color:#e11d48;text-align:center;margin-bottom:20px;}
.message-box {background:#ffe4e6;padding:20px;border-radius:10px;font-size:16px;line-height:1.6;color:#4b5563;}
.footer {margin-top:25px;font-size:12px;text-align:center;color:#6b7280;}
.unsubscribe {color:#e11d48;text-decoration:none;font-weight:bold;}
</style>
</head>
<body>
    <div class="container">
        <div class="header">❤️ A Message for You</div>
        <div class="message-box">
            Hi ${name || "there"},<br><br>
            ${message}
        </div>
        <div class="footer">
            Want to stop receiving these?<br>
            <a class="unsubscribe" href="${unsubscribeLink}">Unsubscribe here</a>.
        </div>
    </div>
</body>
</html>`;
}

// --------------------------------------------------
// AUTH MIDDLEWARE
// --------------------------------------------------
function authCustomer(req, res, next) {
    try {
        const token = req.cookies.customer_token;
        if (!token) return res.status(401).json({ error: "Not logged in" });

        req.user = jwt.verify(token, process.env.JWT_SECRET);
        if (req.user.role !== "customer") throw new Error();
        next();
    } catch {
        res.clearCookie("customer_token");
        return res.status(401).json({ error: "Invalid session" });
    }
}

function authAdmin(req, res, next) {
    try {
        const token = req.cookies.admin_token;
        if (!token) {
            return res.status(401).json({ error: "Not logged in" });
        }

        req.admin = jwt.verify(token, process.env.JWT_SECRET);
        if (req.admin.role !== "admin") throw new Error();

        next();
    } catch (err) {
        res.clearCookie("admin_token");
        return res.status(401).json({ error: "Invalid admin session" });
    }
}

// --------------------------------------------------
// SEED DEFAULT ADMIN
// --------------------------------------------------
async function seedAdmin() {
    const exists = await pool.query("SELECT id FROM admins LIMIT 1");
    if (exists.rows.length === 0) {
        const hash = await bcrypt.hash("Admin123!", 10);
        await pool.query(
            `
            INSERT INTO admins (email, password_hash)
            VALUES ($1,$2)
        `,
            ["admin@lovetextforher.com", hash]
        );
        console.log("🌟 DEFAULT ADMIN CREATED");
    }
}
seedAdmin();

// --------------------------------------------------
// CUSTOMER REGISTER
// --------------------------------------------------
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
            `
            INSERT INTO customers (email, password_hash, name)
            VALUES ($1,$2,$3)
        `,
            [email, hash, name || null]
        );

        res.json({ success: true });
    } catch (err) {
        console.error("REGISTER ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// CUSTOMER LOGIN
// ============================================================
app.post("/api/customer/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        const lookup = await pool.query(
            "SELECT * FROM customers WHERE email=$1",
            [email]
        );

        if (lookup.rows.length === 0)
            return res.status(400).json({ error: "Invalid credentials" });

        const user = lookup.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);

        if (!valid)
            return res.status(400).json({ error: "Invalid credentials" });

        const token = jwt.sign(
            { id: user.id, email: user.email, role: "customer" },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.cookie("customer_token", token, {
            httpOnly: true,
            secure: false, // IMPORTANT FOR LOCALHOST
            sameSite: "lax",
            path: "/",
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        res.json({ success: true });
    } catch (err) {
        console.error("CUSTOMER LOGIN ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// CUSTOMER LOGOUT
// ============================================================
app.post("/api/customer/logout", (req, res) => {
    res.clearCookie("customer_token", {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
    });
    res.json({ success: true });
});

// ============================================================
// CUSTOMER DATA
// ============================================================
app.get("/api/customer/me", authCustomer, async (req, res) => {
    try {
        const q = await pool.query(
            `
            SELECT id, email, name, created_at
            FROM customers
            WHERE id=$1
        `,
            [req.user.id]
        );

        res.json(q.rows[0]);
    } catch (err) {
        console.error("ME ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// RECIPIENTS
// ============================================================
app.get("/api/customer/recipients", authCustomer, async (req, res) => {
    const q = await pool.query(
        `
        SELECT *
        FROM users
        WHERE customer_id=$1
        ORDER BY id DESC
    `,
        [req.user.id]
    );

    res.json(q.rows);
});

// ADD RECIPIENT (subscription required)
app.post("/api/customer/recipients", authCustomer, async (req, res) => {
    try {
        const subCheck = await pool.query(
            "SELECT has_subscription FROM customers WHERE id=$1",
            [req.user.id]
        );

        if (!subCheck.rows[0]?.has_subscription) {
            return res.status(403).json({
                error: "You must have an active subscription to add a recipient.",
            });
        }

        const { name, email, frequency, timings, timezone } = req.body;

        const token = crypto.randomBytes(40).toString("hex");
        const next = calculateNextDelivery(frequency, timings);

        await pool.query(
            `
            INSERT INTO users
              (email, customer_id, name, frequency, timings, timezone, next_delivery, unsubscribe_token)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
            [email, req.user.id, name, frequency, timings, timezone, next, token]
        );

        res.json({ success: true });
    } catch (err) {
        console.error("ADD RECIPIENT ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

app.get("/api/customer/subscription", authCustomer, async (req, res) => {
    const q = await pool.query(
        "SELECT has_subscription FROM customers WHERE id=$1",
        [req.user.id]
    );
    res.json({ subscribed: q.rows[0]?.has_subscription || false });
});

// DELETE RECIPIENT
app.delete("/api/customer/recipients/:id", authCustomer, async (req, res) => {
    try {
        await pool.query("DELETE FROM users WHERE id=$1 AND customer_id=$2", [
            req.params.id,
            req.user.id,
        ]);
        res.json({ success: true });
    } catch (err) {
        console.error("DELETE RECIPIENT ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// STRIPE CHECKOUT (NEW) — $5 BASIC PLAN
// ============================================================
app.post("/api/stripe/checkout", authCustomer, async (req, res) => {
    if (!stripe) return res.status(500).json({ error: "Stripe not configured" });

    try {
        const priceId = process.env.STRIPE_BASIC_PRICE_ID;
        if (!priceId) {
            return res.status(500).json({ error: "Missing STRIPE_BASIC_PRICE_ID" });
        }

        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            payment_method_types: ["card"],
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            client_reference_id: String(req.user.id),
            customer_email: req.user.email,
            success_url: `${process.env.BASE_URL}/payment-success.html`,
            cancel_url: `${process.env.BASE_URL}/products.html`,
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error("CHECKOUT ERROR:", err);
        res.status(500).json({ error: "Checkout failed" });
    }
});

// ============================================================
// PASSWORD RESET
// ============================================================
app.post("/api/reset/request", async (req, res) => {
    try {
        const { email } = req.body;

        const lookup = await pool.query(
            "SELECT id FROM customers WHERE email=$1",
            [email]
        );

        // ALWAYS return success to avoid checking emails
        if (lookup.rows.length === 0) return res.json({ success: true });

        const token = crypto.randomBytes(40).toString("hex");

        await pool.query(
            `
            INSERT INTO password_reset_tokens (customer_id, token, expires_at)
            VALUES ($1,$2, NOW() + INTERVAL '1 hour')
        `,
            [lookup.rows[0].id, token]
        );

        const url = `${process.env.BASE_URL}/reset.html?token=${token}`;

        await sendEmail(
            email,
            "Reset Your Password ❤️",
            `<p>Click to reset: <a href="${url}">${url}</a></p>`,
            url
        );

        res.json({ success: true });
    } catch (err) {
        console.error("RESET REQUEST ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// RESET CONFIRM
app.post("/api/reset/confirm", async (req, res) => {
    try {
        const { token, password } = req.body;

        const lookup = await pool.query(
            `
            SELECT *
            FROM password_reset_tokens
            WHERE token=$1
              AND used=false
              AND expires_at > NOW()
        `,
            [token]
        );

        if (lookup.rows.length === 0)
            return res.status(400).json({ error: "Invalid or expired token" });

        const record = lookup.rows[0];

        const hash = await bcrypt.hash(password, 10);

        await pool.query(
            "UPDATE customers SET password_hash=$1 WHERE id=$2",
            [hash, record.customer_id]
        );

        await pool.query(
            "UPDATE password_reset_tokens SET used=true WHERE id=$1",
            [record.id]
        );

        res.json({ success: true });
    } catch (err) {
        console.error("RESET CONFIRM ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// ADMIN LOGIN / LOGOUT
// ============================================================
app.post("/api/admin/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        const lookup = await pool.query(
            "SELECT * FROM admins WHERE email=$1",
            [email]
        );

        if (lookup.rows.length === 0)
            return res.status(400).json({ error: "Invalid credentials" });

        const admin = lookup.rows[0];
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
            secure: false, // for localhost
            sameSite: "lax",
            path: "/",
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        res.json({ success: true });
    } catch (err) {
        console.error("ADMIN LOGIN ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

app.post("/api/admin/logout", (req, res) => {
    res.clearCookie("admin_token", {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
    });
    res.json({ success: true });
});

// ============================================================
// ADMIN — ALL RECIPIENTS
// ============================================================
app.get("/api/admin/users", authAdmin, async (req, res) => {
    try {
        const q = await pool.query(`
            SELECT * FROM users ORDER BY id DESC
        `);
        res.json(q.rows);
    } catch (err) {
        console.error("ADMIN USERS ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ADMIN DELETE RECIPIENT
app.delete("/api/admin/recipient/:id", authAdmin, async (req, res) => {
    try {
        await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error("ADMIN DELETE USER ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// ADMIN — ALL CUSTOMERS
// ============================================================
app.get("/api/admin/customers", authAdmin, async (req, res) => {
    try {
        const q = await pool.query(`
            SELECT id, email, name, created_at
            FROM customers
            ORDER BY id DESC
        `);
        res.json(q.rows);
    } catch (err) {
        console.error("ADMIN CUSTOMERS ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ADMIN DELETE CUSTOMER + EVERYTHING THEY OWN
app.delete("/api/admin/customer/:id", authAdmin, async (req, res) => {
    try {
        const id = req.params.id;

        await pool.query("DELETE FROM users WHERE customer_id=$1", [id]);
        await pool.query("DELETE FROM carts WHERE customer_id=$1", [id]);
        await pool.query(
            "DELETE FROM password_reset_tokens WHERE customer_id=$1",
            [id]
        );

        const q = await pool.query(
            "DELETE FROM customers WHERE id=$1 RETURNING id",
            [id]
        );

        if (q.rowCount === 0)
            return res.status(404).json({ error: "Not found" });

        res.json({ success: true });
    } catch (err) {
        console.error("ADMIN DELETE CUSTOMER ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// UNSUBSCRIBE
// ============================================================
app.post("/api/unsubscribe/:token", async (req, res) => {
    try {
        const q = await pool.query(
            `
            DELETE FROM users 
            WHERE unsubscribe_token=$1
            RETURNING id
        `,
            [req.params.token]
        );

        if (q.rowCount === 0)
            return res.status(400).json({ error: "Invalid token" });

        res.json({ success: true });
    } catch (err) {
        console.error("UNSUBSCRIBE ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// CART SYSTEM
// ============================================================
async function getCart(customerId) {
    const q = await pool.query(
        "SELECT items FROM carts WHERE customer_id=$1",
        [customerId]
    );

    if (q.rows.length === 0) {
        await pool.query(
            "INSERT INTO carts (customer_id, items) VALUES ($1,'[]')",
            [customerId]
        );
        return [];
    }

    return q.rows[0].items || [];
}

async function saveCart(customerId, items) {
    await pool.query("UPDATE carts SET items=$1 WHERE customer_id=$2", [
        JSON.stringify(items),
        customerId,
    ]);
}

app.get("/api/cart", authCustomer, async (req, res) => {
    try {
        res.json({ items: await getCart(req.user.id) });
    } catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});

app.post("/api/cart/add", authCustomer, async (req, res) => {
    try {
        const { productId } = req.body;

        let cart = await getCart(req.user.id);
        const item = cart.find((i) => i.productId === productId);

        if (item) item.quantity++;
        else cart.push({ productId, quantity: 1 });

        await saveCart(req.user.id, cart);

        res.json({ success: true, items: cart });
    } catch (err) {
        console.error("CART ADD ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

app.post("/api/cart/remove", authCustomer, async (req, res) => {
    try {
        const { productId } = req.body;

        let cart = await getCart(req.user.id);
        cart = cart.filter((item) => item.productId !== productId);

        await saveCart(req.user.id, cart);

        res.json({ success: true, items: cart });
    } catch (err) {
        console.error("CART REMOVE ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// ADMIN KPIs
// ============================================================
app.get("/api/admin/kpis", authAdmin, async (req, res) => {
    try {
        const customers = await pool.query(`SELECT COUNT(*) FROM customers`);
        const totalRecipients = await pool.query(`SELECT COUNT(*) FROM users`);
        const activeRecipients = await pool.query(
            `SELECT COUNT(*) FROM users WHERE is_active=true`
        );
        const unsubscribed = await pool.query(
            `SELECT COUNT(*) FROM users WHERE is_active=false`
        );

        const activeSubs = 0;
        const mrr = 0;
        const churn = 0;

        const totalCarts = await pool.query(`SELECT COUNT(*) FROM carts`);

        const activeCarts = await pool.query(`
            SELECT COUNT(*) 
            FROM carts 
            WHERE items::text NOT IN ('[]', '', 'null')
        `);

        const avgCartValue = 0;
        const recoverableRevenue = 0;

        res.json({
            customers: { total: Number(customers.rows[0].count) },
            recipients: {
                total: Number(totalRecipients.rows[0].count),
                active: Number(activeRecipients.rows[0].count),
                unsubscribed: Number(unsubscribed.rows[0].count),
                netGrowth:
                    Number(activeRecipients.rows[0].count) -
                    Number(unsubscribed.rows[0].count),
            },
            subscriptions: {
                active: activeSubs,
                mrr: mrr,
                churnRate: churn,
            },
            carts: {
                total: Number(totalCarts.rows[0].count),
                active: Number(activeCarts.rows[0].count),
                avgCartValue: avgCartValue,
                recoverableRevenue: recoverableRevenue,
            },
        });
    } catch (err) {
        console.error("ADMIN KPIS ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// MESSAGE LOGIC
// ============================================================
const LOVE_MESSAGES = [
    "❤️ You are deeply appreciated.",
    "💖 Thinking of you brings me joy.",
    "💕 You are loved more than you know.",
    "😘 You make every day brighter.",
    "💞 You're someone's favorite person.",
];

function getMessage(name) {
    const msg =
        LOVE_MESSAGES[Math.floor(Math.random() * LOVE_MESSAGES.length)];
    return name ? `${name}, ${msg}` : msg;
}

// NEXT DELIVERY CALCULATION
function calculateNextDelivery(freq, timings = []) {
    const now = new Date();
    const next = new Date();

    const times = {
        morning: 8,
        afternoon: 13,
        evening: 19,
        night: 22,
    };

    next.setHours(times[timings?.[0]] || 8, 0, 0, 0);

    if (next <= now) {
        const add = {
            daily: 1,
            "every-other-day": 2,
            "three-times-week": 2,
            weekly: 7,
            "bi-weekly": 14,
        };
        next.setDate(next.getDate() + (add[freq] || 1));
    }

    return next;
}

// ============================================================
// CRON ENGINE
// ============================================================
cron.schedule("* * * * *", async () => {
    console.log("⏱ CRON: scanning…");

    const client = await pool.connect();
    try {
        const now = new Date();

        const due = await client.query(
            `
            SELECT *
            FROM users
            WHERE is_active=true
            AND next_delivery <= $1
        `,
            [now]
        );

        for (const u of due.rows) {
            const unsubscribe = `${process.env.BASE_URL}/unsubscribe.html?token=${u.unsubscribe_token}`;
            const msg = getMessage(u.name);
            const html = buildLoveEmailHTML(u.name, msg, unsubscribe);

            await sendEmail(
                u.email,
                "Your Love Message ❤️",
                html,
                msg + "\n\nUnsubscribe: " + unsubscribe
            );

            const next = calculateNextDelivery(u.frequency, u.timings);

            await client.query(
                `
                UPDATE users
                SET next_delivery=$1, last_sent=NOW()
                WHERE id=$2
            `,
                [next, u.id]
            );
        }
    } catch (err) {
        console.error("CRON ERROR:", err);
    } finally {
        client.release();
    }
});

// ============================================================
// ADMIN SESSION VERIFY
// ============================================================
app.get("/api/admin/me", authAdmin, async (req, res) => {
    res.json({ success: true, admin: req.admin });
});

// ============================================================
// ADMIN — SEND MESSAGE NOW
// ============================================================
app.post("/api/admin/send-now/:id", authAdmin, async (req, res) => {
    try {
        const id = req.params.id;

        const q = await pool.query(
            `
            SELECT *
            FROM users
            WHERE id=$1
        `,
            [id]
        );

        if (q.rows.length === 0)
            return res.status(404).json({ error: "Recipient not found" });

        const u = q.rows[0];

        const unsubscribeLink = `${process.env.BASE_URL}/unsubscribe.html?token=${u.unsubscribe_token}`;
        const msg = getMessage(u.name);
        const html = buildLoveEmailHTML(u.name, msg, unsubscribeLink);

        await sendEmail(
            u.email,
            "Your Love Message ❤️",
            html,
            msg + "\n\nUnsubscribe: " + unsubscribeLink
        );

        await pool.query(
            `
            UPDATE users
            SET last_sent=NOW()
            WHERE id=$1
        `,
            [id]
        );

        res.json({ success: true });
    } catch (err) {
        console.error("ADMIN SEND-NOW ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// STRIPE BILLING PORTAL
// ============================================================
app.get("/api/customer/subscription/portal", authCustomer, async (req, res) => {
    if (!stripe) return res.status(500).json({ error: "Stripe not configured" });

    try {
        const customer = await pool.query(
            "SELECT stripe_customer_id FROM customers WHERE id=$1",
            [req.user.id]
        );

        if (!customer.rows[0]?.stripe_customer_id) {
            return res.status(400).json({ error: "No Stripe customer found" });
        }

        const session = await stripe.billingPortal.sessions.create({
            customer: customer.rows[0].stripe_customer_id,
            return_url: `${process.env.BASE_URL}/dashboard.html`,
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error("PORTAL ERROR:", err);
        res.status(500).json({ error: "Failed to launch billing portal" });
    }
});
// ============================================================
// STRIPE CHECKOUT — CREATE SUBSCRIPTION SESSION
// ============================================================
app.post("/api/stripe/checkout", authCustomer, async (req, res) => {
    try {
        if (!stripe) {
            return res.status(500).json({ error: "Stripe not configured" });
        }

        const { productId } = req.body;

        // Map frontend productId → Stripe price IDs
        const PRICE_MAP = {
            "love-basic": process.env.STRIPE_PRICE_BASIC,     // example: price_123
            "love-premium": process.env.STRIPE_PRICE_PREMIUM,
        };

        const priceId = PRICE_MAP[productId];

        if (!priceId) {
            return res.status(400).json({ error: "Unknown product" });
        }

        // Check if customer already has a Stripe account
        let stripeCustomerId;

        const existing = await pool.query(
            `SELECT stripe_customer_id FROM customers WHERE id=$1`,
            [req.user.id]
        );

        if (existing.rows[0] && existing.rows[0].stripe_customer_id) {
            stripeCustomerId = existing.rows[0].stripe_customer_id;
        } else {
            // Create a new Stripe customer
            const customer = await stripe.customers.create({
                email: req.user.email,
                metadata: { customerId: req.user.id }
            });

            stripeCustomerId = customer.id;

            await pool.query(
                `UPDATE customers SET stripe_customer_id=$1 WHERE id=$2`,
                [stripeCustomerId, req.user.id]
            );
        }

        // Create checkout session
        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            payment_method_types: ["card"],
            customer: stripeCustomerId,

            line_items: [
                {
                    price: priceId,
                    quantity: 1
                }
            ],

            success_url: `${process.env.BASE_URL}/dashboard.html?success=true`,
            cancel_url: `${process.env.BASE_URL}/cart.html?canceled=true`
        });

        res.json({ url: session.url });

    } catch (err) {
        console.error("STRIPE CHECKOUT ERROR:", err);
        res.status(500).json({ error: "Unable to create checkout session" });
    }
});
// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
    console.log(`🚀 LoveTextForHer running on port ${PORT}`);
});