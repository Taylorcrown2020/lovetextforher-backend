CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);
CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(active);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_customer ON promo_code_redemptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_promo ON promo_code_redemptions(promo_code_id);