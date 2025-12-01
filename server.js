process.env.TZ = "UTC";

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const cron = require("node-cron");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

/* -------------------------------------------------------------------------- */
/*                        STATIC FILES (MUST BE HIGH)                         */
/* -------------------------------------------------------------------------- */

// Serve all HTML/CSS/JS from /public
app.use(express.static(path.join(__dirname, "public")));

/* -------------------------------------------------------------------------- */
/*                                 JWT CHECK                                  */
/* -------------------------------------------------------------------------- */

if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET missing in environment!");
}

/* -------------------------------------------------------------------------- */
/*                               STRIPE SETUP                                 */
/* -------------------------------------------------------------------------- */

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
    stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    console.log("⚡ Stripe loaded");
} else {
    console.log("⚠️ STRIPE_SECRET_KEY missing — Stripe disabled");
}

/* -------------------------------------------------------------------------- */
/*                                DATABASE                                    */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*                     STRIPE WEBHOOK (MUST COME FIRST)                       */
/* -------------------------------------------------------------------------- */

app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
        if (!stripe) return res.status(500).send("Stripe not configured");

        const sig = req.headers["stripe-signature"];
        let event;

        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                sig,
                process.env.STRIPE_WEBHOOK_SECRET
            );
        } catch (err) {
            console.error("❌ Webhook Signature Fail:", err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        console.log("⚡ STRIPE EVENT:", event.type);

        try {
            /* ------------------------- CHECKOUT SUCCESS ------------------------ */
            if (event.type === "checkout.session.completed") {
                const session = event.data.object;
                const stripeCustomerId = session.customer;

                const planType = session.metadata?.plan_type;
                const localId = session.metadata?.customerId;

                if (!localId) {
                    console.error("❌ No local customerId in metadata");
                    return res.json({ received: true });
                }

                if (planType === "trial-plus") {
                    await pool.query(
                        `
                        UPDATE customers
                        SET stripe_customer_id=$1,
                            has_subscription=true,
                            trial_active=true,
                            trial_end=NOW() + INTERVAL '3 days'
                        WHERE id=$2
                    `,
                        [stripeCustomerId, localId]
                    );
                } else {
                    await pool.query(
                        `
                        UPDATE customers
                        SET stripe_customer_id=$1,
                            has_subscription=true,
                            trial_active=false,
                            trial_end=NULL
                        WHERE id=$2
                    `,
                        [stripeCustomerId, localId]
                    );
                }

                // Clear cart after subscription
                await pool.query(
                    "UPDATE carts SET items='[]' WHERE customer_id=$1",
                    [localId]
                );

                console.log("🎉 Subscription updated:", localId);
            }

            /* ------------------------- SUBSCRIPTION CANCELED ------------------- */
            if (event.type === "customer.subscription.deleted") {
                const cust = event.data.object.customer;
                await pool.query(
                    `
                    UPDATE customers
                    SET has_subscription=false,
                        trial_active=false,
                        trial_end=NULL
                    WHERE stripe_customer_id=$1
                `,
                    [cust]
                );
                console.log("❌ Subscription canceled:", cust);
            }

            res.json({ received: true });
        } catch (err) {
            console.error("❌ Webhook Handler Error:", err);
            return res.status(500).send("Webhook handler error");
        }
    }
);

/* -------------------------------------------------------------------------- */
/*                     OTHER MIDDLEWARE MUST COME AFTER WEBHOOK               */
/* -------------------------------------------------------------------------- */

app.use(cors({ origin: ["http://localhost:3000"], credentials: true }));
app.use(express.json());
app.use(cookieParser());

/* -------------------------------------------------------------------------- */
/*                               EMAIL SETUP (RESEND)                          */
/* -------------------------------------------------------------------------- */
app.get("/api/customer/logs", authCustomer, async (req, res) => {
    try {
        const logs = await pool.query(
            `
            SELECT l.id, l.email, l.message, l.sent_at, u.name AS recipient_name
            FROM message_logs l
            JOIN users u ON u.id = l.recipient_id
            WHERE l.customer_id = $1
            ORDER BY l.sent_at DESC
            `,
            [req.user.id]
        );

        res.json(logs.rows);
    } catch (err) {
        console.error("LOGS ERROR:", err);
        res.status(500).json({ error: "Error fetching logs" });
    }
});

async function logMessage(customerId, recipientId, email, msg) {
    try {
        await pool.query(
            `
            INSERT INTO message_logs (customer_id, recipient_id, email, message)
            VALUES ($1, $2, $3, $4)
            `,
            [customerId, recipientId, email, msg]
        );
    } catch (err) {
        console.error("❌ LOGGING ERROR:", err);
    }
}

const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendEmail(to, subject, html, text = "") {
    try {
        const data = await resend.emails.send({
            from: "onboarding@resend.dev", // MUST be verified domain
            to: to,
            subject: subject,
            html: html,
            text: text || html.replace(/<[^>]*>/g, "")
        });

        console.log("📨 RESEND SENT:", data?.id);
        return true;

    } catch (err) {
        console.error("❌ RESEND SEND ERROR:", err);
        return false;
    }
}

/* -------------------------------------------------------------------------- */
/*                         AUTH MIDDLEWARE (CLEAN)                            */
/* -------------------------------------------------------------------------- */

function authCustomer(req, res, next) {
    try {
        const token = req.cookies.customer_token;
        if (!token) return res.status(401).json({ error: "Not logged in" });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role !== "customer") throw new Error();

        req.user = decoded;
        next();
    } catch {
        res.clearCookie("customer_token");
        return res.status(401).json({ error: "Invalid session" });
    }
}

function authAdmin(req, res, next) {
    try {
        const token = req.cookies.admin_token;
        if (!token) return res.status(401).json({ error: "Not logged in" });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role !== "admin") throw new Error();

        req.admin = decoded;
        next();
    } catch {
        res.clearCookie("admin_token");
        return res.status(401).json({ error: "Invalid admin session" });
    }
}

/* -------------------------------------------------------------------------- */
/*                               SEED ADMIN                                   */
/* -------------------------------------------------------------------------- */

async function seedAdmin() {
    const check = await pool.query("SELECT id FROM admins LIMIT 1");
    if (check.rows.length === 0) {
        const hash = await bcrypt.hash("Admin123!", 10);
        await pool.query(
            "INSERT INTO admins (email, password_hash) VALUES ($1,$2)",
            ["admin@lovetextforher.com", hash]
        );
        console.log("🌟 DEFAULT ADMIN CREATED");
    }
}
seedAdmin();

/* -------------------------------------------------------------------------- */
/*                        CUSTOMER REGISTER & LOGIN                            */
/* -------------------------------------------------------------------------- */

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
            secure: false,
            sameSite: "lax",
            path: "/",
            maxAge: 7 * 24 * 60 * 60 * 1000,
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
        secure: false,
        sameSite: "lax",
        path: "/",
    });
    res.json({ success: true });
});

/* -------------------------------------------------------------------------- */
/*                             CUSTOMER PROFILE                               */
/* -------------------------------------------------------------------------- */

app.get("/api/customer/me", authCustomer, async (req, res) => {
    try {
        const q = await pool.query(
            `
            SELECT id, email, name, created_at,
                   has_subscription, trial_active, trial_end
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

/* -------------------------------------------------------------------------- */
/*                 RECIPIENTS (Requires subscription or trial)                */
/* -------------------------------------------------------------------------- */

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

/* Add Recipient */
app.post("/api/customer/recipients", authCustomer, async (req, res) => {
    try {
        const sub = await pool.query(
            `
            SELECT has_subscription, trial_active, trial_end
            FROM customers
            WHERE id=$1
        `,
            [req.user.id]
        );

        const c = sub.rows[0];

        const trialActive =
            c.trial_active &&
            c.trial_end &&
            new Date(c.trial_end) > new Date();

        if (!c.has_subscription && !trialActive) {
            return res.status(403).json({
                error:
                    "A subscription or active free trial is required to add a recipient.",
            });
        }

        const { name, email, frequency, timings, timezone } = req.body;

        const token = crypto.randomBytes(40).toString("hex");
        const next = calculateNextDelivery(frequency, timings);

        await pool.query(
            `
            INSERT INTO users
            (email, customer_id, name, frequency, timings, timezone,
             next_delivery, unsubscribe_token, is_active)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
        `,
            [email, req.user.id, name, frequency, timings, timezone, next, token]
        );

        res.json({ success: true });
    } catch (err) {
        console.error("ADD RECIPIENT ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* Delete Recipient */
app.delete("/api/customer/recipients/:id", authCustomer, async (req, res) => {
    try {
        await pool.query(
            "DELETE FROM users WHERE id=$1 AND customer_id=$2",
            [req.params.id, req.user.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("DELETE RECIPIENT ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* -------------------------------------------------------------------------- */
/*                           SUBSCRIPTION STATUS                              */
/* -------------------------------------------------------------------------- */

app.get("/api/customer/subscription", authCustomer, async (req, res) => {
    const q = await pool.query(
        `
        SELECT has_subscription, trial_active, trial_end
        FROM customers
        WHERE id=$1
    `,
        [req.user.id]
    );

    const c = q.rows[0];

    const trialActive =
        c.trial_active &&
        c.trial_end &&
        new Date(c.trial_end) > new Date();

    res.json({
        subscribed: c.has_subscription || trialActive,
        has_subscription: c.has_subscription,
        trial_active: trialActive,
        trial_end: c.trial_end,
    });
});

/* -------------------------------------------------------------------------- */
/*                         FREE TRIAL CHECKOUT START                          */
/* -------------------------------------------------------------------------- */

app.post("/api/stripe/start-free-trial", authCustomer, async (req, res) => {
    try {
        if (!stripe) return res.status(500).json({ error: "Stripe not configured" });

        const priceId = process.env.STRIPE_FREETRIAL_PRICE_ID;

        if (!priceId)
            return res
                .status(500)
                .json({ error: "Missing STRIPE_FREETRIAL_PRICE_ID" });

        const stripeCustomerId = await ensureStripeCustomer(
            req.user.id,
            req.user.email
        );

        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            customer: stripeCustomerId,
            payment_method_types: ["card"],
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            metadata: {
                customerId: req.user.id,
                plan_type: "trial-plus",
            },
            success_url: `${process.env.BASE_URL}/dashboard.html?trial=started`,
            cancel_url: `${process.env.BASE_URL}/products.html`,
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error("FREE TRIAL CHECKOUT ERROR:", err);
        res.status(500).json({ error: "Unable to start trial" });
    }
});

/* -------------------------------------------------------------------------- */
/*                 PRODUCT CHECKOUT (basic / plus / trial)                    */
/* -------------------------------------------------------------------------- */

app.post("/api/stripe/checkout", authCustomer, async (req, res) => {
    try {
        if (!stripe) return res.status(500).json({ error: "Stripe not configured" });

        const { productId } = req.body;

        const PRODUCT_MAP = {
            "free-trial": {
                priceId: process.env.STRIPE_FREETRIAL_PRICE_ID,
                plan_type: "trial-plus",
            },
            "love-basic": {
                priceId: process.env.STRIPE_BASIC_PRICE_ID,
                plan_type: "basic",
            },
            "love-plus": {
                priceId: process.env.STRIPE_PLUS_PRICE_ID,
                plan_type: "plus",
            },
        };

        const product = PRODUCT_MAP[productId];
        if (!product) return res.status(400).json({ error: "Invalid product ID" });

        const stripeCustomerId = await ensureStripeCustomer(
            req.user.id,
            req.user.email
        );

        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            customer: stripeCustomerId,
            payment_method_types: ["card"],
            line_items: [
                {
                    price: product.priceId,
                    quantity: 1,
                },
            ],
            metadata: {
                customerId: req.user.id,
                plan_type: product.plan_type,
            },
            success_url: `${process.env.BASE_URL}/dashboard.html?sub=success`,
            cancel_url: `${process.env.BASE_URL}/products.html?canceled=true`,
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error("CHECKOUT ERROR:", err);
        res.status(500).json({ error: "Checkout failed" });
    }
});

/* -------------------------------------------------------------------------- */
/*                   ENSURE STRIPE CUSTOMER RECORD EXISTS                     */
/* -------------------------------------------------------------------------- */

async function ensureStripeCustomer(customerId, email) {
    const row = await pool.query(
        "SELECT stripe_customer_id FROM customers WHERE id=$1",
        [customerId]
    );

    if (row.rows[0]?.stripe_customer_id)
        return row.rows[0].stripe_customer_id;

    const newCust = await stripe.customers.create({
        email,
        metadata: { customerId },
    });

    await pool.query(
        "UPDATE customers SET stripe_customer_id=$1 WHERE id=$2",
        [newCust.id, customerId]
    );

    return newCust.id;
}

/* -------------------------------------------------------------------------- */
/*                                PASSWORD RESET                              */
/* -------------------------------------------------------------------------- */

app.post("/api/reset/request", async (req, res) => {
    try {
        const { email } = req.body;

        const row = await pool.query(
            "SELECT id FROM customers WHERE email=$1",
            [email]
        );

        if (row.rows.length === 0)
            return res.json({ success: true });

        const token = crypto.randomBytes(40).toString("hex");

        await pool.query(
            `
            INSERT INTO password_reset_tokens (customer_id, token, expires_at)
            VALUES ($1,$2, NOW() + INTERVAL '1 hour')
        `,
            [row.rows[0].id, token]
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

/* Confirm Reset */
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

/* -------------------------------------------------------------------------- */
/*                             ADMIN — ME                                     */
/* -------------------------------------------------------------------------- */

app.get("/api/admin/me", authAdmin, async (req, res) => {
    res.json({
        admin: {
            id: req.admin.id,
            email: req.admin.email,
            role: "admin",
        },
    });
});

/* -------------------------------------------------------------------------- */
/*                                 CART SYSTEM                                */
/* -------------------------------------------------------------------------- */

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
    await pool.query(
        "UPDATE carts SET items=$1 WHERE customer_id=$2",
        [JSON.stringify(items), customerId]
    );
}

app.get("/api/cart", authCustomer, async (req, res) => {
    try {
        const items = await getCart(req.user.id);
        res.json({ items });
    } catch (err) {
        console.error("CART GET ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

app.post("/api/cart/add", authCustomer, async (req, res) => {
    try {
        const { productId } = req.body;
        let cart = await getCart(req.user.id);

        const existing = cart.find(i => i.productId === productId);
        if (existing) existing.quantity++;
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
        cart = cart.filter(i => i.productId !== productId);

        await saveCart(req.user.id, cart);

        res.json({ success: true, items: cart });
    } catch (err) {
        console.error("CART REMOVE ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* -------------------------------------------------------------------------- */
/*                              ADMIN LOGIN / LOGOUT                          */
/* -------------------------------------------------------------------------- */

app.post("/api/admin/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        const lookup = await pool.query(
            "SELECT * FROM admins WHERE email=$1",
            [email]
        );

        if (lookup.rows.length === 0) {
            return res
                .status(400)
                .json({ error: "Invalid email or password." });
        }

        const admin = lookup.rows[0];

        const match = await bcrypt.compare(password, admin.password_hash);

        if (!match) {
            return res
                .status(400)
                .json({ error: "Invalid email or password." });
        }

        const token = jwt.sign(
            { id: admin.id, email: admin.email, role: "admin" },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

res.cookie("admin_token", token, {
    httpOnly: true,
    secure: false,   // change to true if you enable HTTPS locally later
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

/* -------------------------------------------------------------------------- */
/*                               ADMIN — USERS                                */
/* -------------------------------------------------------------------------- */

app.get("/api/admin/users", authAdmin, async (req, res) => {
    try {
        const q = await pool.query(
            `SELECT * FROM users ORDER BY id DESC`
        );
        res.json(q.rows);
    } catch (err) {
        console.error("ADMIN USERS ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

app.delete("/api/admin/recipient/:id", authAdmin, async (req, res) => {
    try {
        await pool.query(
            "DELETE FROM users WHERE id=$1",
            [req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("ADMIN DELETE USER ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* -------------------------------------------------------------------------- */
/*                            ADMIN — CUSTOMERS                               */
/* -------------------------------------------------------------------------- */

app.get("/api/admin/customers", authAdmin, async (req, res) => {
    try {
        const q = await pool.query(`
            SELECT id, email, name, created_at,
                   has_subscription, trial_active, trial_end
            FROM customers
            ORDER BY id DESC
        `);
        res.json(q.rows);
    } catch (err) {
        console.error("ADMIN CUSTOMERS ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

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

/* -------------------------------------------------------------------------- */
/*                           ADMIN — SEND A MESSAGE NOW                       */
/* -------------------------------------------------------------------------- */

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

        await logMessage(u.customer_id, u.id, u.email, msg);


        await pool.query(
            "UPDATE users SET last_sent=NOW() WHERE id=$1",
            [id]
        );

        res.json({ success: true });
    } catch (err) {
        console.error("ADMIN SEND-NOW ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* -------------------------------------------------------------------------- */
/*                                ADMIN KPIs                                  */
/* -------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------- */
/*                                ADMIN KPIs                                  */
/* -------------------------------------------------------------------------- */

app.get("/api/admin/kpis", authAdmin, async (req, res) => {
    try {
        /* Customers */
        const totalCustomers = Number(
            (await pool.query(`SELECT COUNT(*) FROM customers`)).rows[0].count
        );

        /* Recipients */
        const totalRecipients = Number(
            (await pool.query(`SELECT COUNT(*) FROM users`)).rows[0].count
        );
        const activeRecipients = Number(
            (await pool.query(`SELECT COUNT(*) FROM users WHERE is_active=true`)).rows[0].count
        );
        const unsubRecipients = Number(
            (await pool.query(`SELECT COUNT(*) FROM users WHERE is_active=false`)).rows[0].count
        );

        /* Net 30-day growth */
        const recentRecipients = Number(
            (await pool.query(`
                SELECT COUNT(*) 
                FROM users 
                WHERE created_at >= NOW() - INTERVAL '30 days'
            `)).rows[0].count
        );

        const deletedRecipients30 = Number(
            (await pool.query(`
                SELECT COUNT(*) 
                FROM users
                WHERE is_active=false 
                AND last_sent >= NOW() - INTERVAL '30 days'
            `)).rows[0].count
        );

        const netGrowth = recentRecipients - deletedRecipients30;

        /* Subscriptions */
        const activeSubs = Number(
            (await pool.query(`
                SELECT COUNT(*) 
                FROM customers 
                WHERE has_subscription=true
            `)).rows[0].count
        );

        /* Basic MRR calculation */
        const BASIC = Number(process.env.PRICE_BASIC || 4.99);
        const PLUS = Number(process.env.PRICE_PLUS || 9.99);

        const basicCount = Number(
            (await pool.query(`
                SELECT COUNT(*) 
                FROM customers 
                WHERE has_subscription=true 
                AND stripe_customer_id IS NOT NULL
            `)).rows[0].count
        );

        // You can expand this if you track plan type per customer
        const mrr = (basicCount * BASIC).toFixed(2);

        /* Churn (last 30 days canceled subs) */
        const churnCount = Number(
            (await pool.query(`
                SELECT COUNT(*) 
                FROM customers
                WHERE has_subscription=false 
                AND updated_at >= NOW() - INTERVAL '30 days'
            `)).rows[0].count
        );

        const churnRate = activeSubs > 0 ? churnCount / activeSubs : 0;

        /* Cart Metrics */
        const cartsTotal = Number(
            (await pool.query(`SELECT COUNT(*) FROM carts`)).rows[0].count
        );

        const activeCarts = Number(
            (await pool.query(`
                SELECT COUNT(*) 
                FROM carts 
                WHERE items::text NOT IN ('[]', '', 'null')
            `)).rows[0].count
        );

        // Avg cart value
        const cartValues = (
            await pool.query(`
                SELECT items 
                FROM carts 
                WHERE items::text NOT IN ('[]', '', 'null')
            `)
        ).rows;

        let totalValue = 0;
        cartValues.forEach(cart => {
            let items = [];
            try { items = JSON.parse(cart.items); } catch {}
            items.forEach(i => {
                if (i.productId === "love-basic") totalValue += BASIC * i.quantity;
                if (i.productId === "love-plus") totalValue += PLUS * i.quantity;
            });
        });

        const avgCartValue =
            activeCarts > 0 ? totalValue / activeCarts : 0;

        const recoverableRevenue = totalValue;

        /* Email deliverability */
        const sentThisMonth = Number(
            (await pool.query(`
                SELECT COUNT(*) 
                FROM message_logs 
                WHERE sent_at >= DATE_TRUNC('month', NOW())
            `)).rows[0].count
        );

        const failedThisMonth = Number(
            (await pool.query(`
                SELECT COUNT(*) 
                FROM message_logs 
                WHERE sent_at >= DATE_TRUNC('month', NOW())
                AND success = false
            `)).rows[0].count
        );

        const deliveryRate =
            sentThisMonth > 0
                ? ((sentThisMonth - failedThisMonth) / sentThisMonth)
                : 1;

        /* Final KPI Response */
        res.json({
            customers: { total: totalCustomers },

            recipients: {
                total: totalRecipients,
                active: activeRecipients,
                unsubscribed: unsubRecipients,
                netGrowth
            },

            subscriptions: {
                active: activeSubs,
                mrr,
                churnRate
            },

            carts: {
                total: cartsTotal,
                active: activeCarts,
                avgCartValue,
                recoverableRevenue
            },

            messages: {
                sentThisMonth,
                failedThisMonth,
                deliveryRate
            }
        });

    } catch (err) {
        console.error("ADMIN KPI ERROR:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* -------------------------------------------------------------------------- */
/*                        MESSAGE GENERATION HELPERS                          */
/* -------------------------------------------------------------------------- */

const LOVE_MESSAGES = [
    "❤️ You are deeply appreciated.",
    "💖 Thinking of you brings me joy.",
    "💕 You are loved more than you know.",
    "😘 You make every day brighter.",
    "💞 You're someone's favorite person.",
];

function getMessage(name) {
    const msg = LOVE_MESSAGES[Math.floor(Math.random() * LOVE_MESSAGES.length)];
    return name ? `${name}, ${msg}` : msg;
}

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

function buildLoveEmailHTML(name, message, unsubscribeUrl) {
    const safeName = name || "There";
    return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color:#d6336c;">Hey ${safeName} 💌</h2>
            <p style="font-size:16px; line-height:1.5;">${message}</p>
            <p style="margin-top:32px; font-size:12px; color:#777;">
                If you no longer want to receive these messages, you can 
                <a href="${unsubscribeUrl}">unsubscribe here</a>.
            </p>
        </div>
    `;
}

/* -------------------------------------------------------------------------- */
/*                           CRON — SEND EMAILS                               */
/* -------------------------------------------------------------------------- */

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

            await logMessage(u.customer_id, u.id, u.email, msg, true);

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

/* -------------------------------------------------------------------------- */
/*                   CUSTOMER — STRIPE BILLING PORTAL                         */
/* -------------------------------------------------------------------------- */

app.get(
    "/api/customer/subscription/portal",
    authCustomer,
    async (req, res) => {
        if (!stripe)
            return res.status(500).json({ error: "Stripe not configured" });

        try {
            const q = await pool.query(
                "SELECT stripe_customer_id FROM customers WHERE id=$1",
                [req.user.id]
            );

            if (!q.rows[0]?.stripe_customer_id)
                return res
                    .status(400)
                    .json({ error: "No Stripe customer found" });

            const session = await stripe.billingPortal.sessions.create({
                customer: q.rows[0].stripe_customer_id,
                return_url: `${process.env.BASE_URL}/dashboard.html`,
            });

            res.json({ url: session.url });
        } catch (err) {
            console.error("PORTAL ERROR:", err);
            res.status(500).json({ error: "Failed to launch billing portal" });
        }
    }
);

/* -------------------------------------------------------------------------- */
/*                               START SERVER                                 */
/* -------------------------------------------------------------------------- */

app.listen(PORT, () => {
    console.log(`🚀 LoveTextForHer Backend Running on Port ${PORT}`);
});