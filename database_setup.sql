-- ============================================================
--  LoveTextForHer — DATABASE SCHEMA (FULLY MATCHED TO server.js)
-- ============================================================

DROP TABLE IF EXISTS carts CASCADE;
DROP TABLE IF EXISTS stripe_subscriptions CASCADE;
DROP TABLE IF EXISTS password_reset_tokens CASCADE;
DROP TABLE IF EXISTS admins CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS customers CASCADE;

-- ============================================================
-- CUSTOMERS — Login Accounts + Subscription Data
-- ============================================================
CREATE TABLE customers (
    id SERIAL PRIMARY KEY,

    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name VARCHAR(100),

    -- REQUIRED BY SERVER.JS
    has_subscription BOOLEAN DEFAULT false,
    trial_active BOOLEAN DEFAULT false,
    trial_end TIMESTAMPTZ,
    stripe_customer_id TEXT,
    subscription_id TEXT,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_customers_email ON customers(email);


-- ============================================================
-- ADMINS — Admin Login
-- ============================================================
CREATE TABLE admins (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_admins_email ON admins(email);


-- ============================================================
-- PASSWORD RESET TOKENS
-- ============================================================
CREATE TABLE password_reset_tokens (
    id SERIAL PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    used BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_reset_tokens_token ON password_reset_tokens(token);


-- ============================================================
-- USERS — Recipient List
-- ============================================================
CREATE TABLE users (
    id SERIAL PRIMARY KEY,

    email VARCHAR(255) NOT NULL,
    customer_id INT REFERENCES customers(id) ON DELETE CASCADE,
    name VARCHAR(100),

    frequency VARCHAR(50) NOT NULL CHECK (frequency IN (
        'daily',
        'every-other-day',
        'three-times-week',
        'weekly',
        'bi-weekly'
    )),

    timings TEXT[] NOT NULL,
    timezone VARCHAR(100) NOT NULL,

    next_delivery TIMESTAMP,
    last_sent TIMESTAMP,
    unsubscribe_token TEXT UNIQUE,
    is_active BOOLEAN DEFAULT true,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_customer_id ON users(customer_id);
CREATE INDEX idx_users_next_delivery ON users(next_delivery);


-- ============================================================
-- CARTS
-- ============================================================
CREATE TABLE carts (
    customer_id INT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    items JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION update_carts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_carts_updated_at
BEFORE UPDATE ON carts
FOR EACH ROW EXECUTE FUNCTION update_carts_updated_at();

CREATE INDEX idx_carts_customer_id ON carts(customer_id);


-- ============================================================
-- STRIPE SUBSCRIPTIONS (OPTIONAL, SAFE TO KEEP)
-- ============================================================
CREATE TABLE stripe_subscriptions (
    id SERIAL PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    stripe_customer_id TEXT NOT NULL,
    stripe_subscription_id TEXT NOT NULL,
    status VARCHAR(50) NOT NULL,
    current_period_end TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_stripe_customer ON stripe_subscriptions(customer_id);
CREATE INDEX idx_stripe_subscription ON stripe_subscriptions(stripe_subscription_id);

-- ============================================================
-- DONE — 100% MATCHES YOUR BACKEND
-- ============================================================