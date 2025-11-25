-- LoveTextForHer Email-Only Database Setup Script (With Unsubscribe Support)

DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(100),
    frequency VARCHAR(50) NOT NULL CHECK (
        frequency IN (
            'daily',
            'every-other-day',
            'three-times-week',
            'weekly',
            'bi-weekly'
        )
    ),
    timings TEXT[] NOT NULL,
    timezone VARCHAR(100) NOT NULL,
    next_delivery TIMESTAMP,
    last_sent TIMESTAMP,
    is_active BOOLEAN DEFAULT true,
    unsubscribe_token VARCHAR(255) UNIQUE,
    subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_active ON users(is_active);
CREATE INDEX idx_users_token ON users(unsubscribe_token);
CREATE INDEX idx_users_next_delivery ON users(next_delivery);

-- Auto update updated_at on UPDATE
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();