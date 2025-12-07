-- ============================================================
--   LoveTextForHer — FINAL DATABASE SCHEMA (WITH PASSWORD RESET)
-- ============================================================

DROP TABLE IF EXISTS password_reset_tokens CASCADE;
DROP TABLE IF EXISTS message_logs CASCADE;
DROP TABLE IF EXISTS carts CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS admins CASCADE;
DROP TABLE IF EXISTS customers CASCADE;

-- ============================================================
-- CUSTOMERS — Login Accounts + Subscription Data
-- ============================================================
CREATE TABLE customers (
    id SERIAL PRIMARY KEY,

    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name VARCHAR(100),

    has_subscription BOOLEAN DEFAULT false,
    current_plan VARCHAR(50) DEFAULT 'none',
    trial_active BOOLEAN DEFAULT false,
    trial_end TIMESTAMPTZ,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_end TIMESTAMPTZ,

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
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_reset_tokens_token ON password_reset_tokens(token);


-- ============================================================
-- USERS — Recipients
-- ============================================================
CREATE TABLE users (
    id SERIAL PRIMARY KEY,

    email VARCHAR(255) NOT NULL,
    customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name VARCHAR(100),
    relationship VARCHAR(50),

    frequency VARCHAR(50) NOT NULL CHECK (frequency IN (
        'daily',
        'every-other-day',
        'three-times-week',
        'weekly',
        'bi-weekly'
    )),

    timings VARCHAR(50) NOT NULL,
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
-- MESSAGE LOGS
-- ============================================================
CREATE TABLE message_logs (
    id SERIAL PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    recipient_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_message_logs_customer ON message_logs(customer_id);
CREATE INDEX idx_message_logs_recipient ON message_logs(recipient_id);


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
-- DONE — FULLY COMPATIBLE WITH UPDATED SERVER (INCLUDING RESET)
-- ============================================================