-- Ashveil Database Schema
-- Run this in Supabase SQL Editor

-- ═══════════════════════════════════════
-- CLIENTS
-- ═══════════════════════════════════════
CREATE TABLE clients (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT,
  color TEXT DEFAULT '#3b82f6',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════════════════════════════
-- USERS
-- ═══════════════════════════════════════
CREATE TABLE users (
  id UUID REFERENCES auth.users PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'viewer')),
  client_id UUID REFERENCES clients(id), -- NULL = access to all (admin)
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════════════════════════════
-- DEBTORS
-- ═══════════════════════════════════════
CREATE TABLE debtors (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID REFERENCES clients(id) NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('cvl', 'commercial')),
  status TEXT DEFAULT 'queued' CHECK (status IN ('queued','active','responding','negotiating','payment_plan','settled','disputed','escalated')),
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),

  -- Director / debtor info
  name TEXT NOT NULL,
  company TEXT NOT NULL,
  co_number TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,

  -- CVL fields
  base_amount DECIMAL(12,2) DEFAULT 0, -- AI-determined recoverable

  -- Commercial fields
  principal DECIMAL(12,2) DEFAULT 0,
  daily_interest DECIMAL(8,2) DEFAULT 79.00,
  invoice_date DATE,

  -- Sequence tracking
  sequence_day INT DEFAULT 0,
  sequence_paused BOOLEAN DEFAULT false,
  sequence_started_at TIMESTAMPTZ,

  -- Financials
  payments DECIMAL(12,2) DEFAULT 0,
  last_contact TIMESTAMPTZ,
  next_action TEXT DEFAULT 'Queued',

  -- Stripe
  stripe_payment_link_id TEXT,
  stripe_payment_link_url TEXT,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════════════════════════════
-- INTELLIGENCE (AI analysis results)
-- ═══════════════════════════════════════
CREATE TABLE intelligence (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  debtor_id UUID REFERENCES debtors(id) ON DELETE CASCADE NOT NULL,
  confidence INT,
  claim_strength TEXT,
  total_recoverable DECIMAL(12,2),
  claims JSONB DEFAULT '[]', -- ["ODLA s212 - ...", "Preference s239 - ..."]
  assets JSONB DEFAULT '[]',
  flags JSONB DEFAULT '[]',
  breakdown JSONB DEFAULT '[]', -- [{"desc": "...", "amt": 1234.00}]
  raw_analysis TEXT, -- Full Claude response for reference
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════════════════════════════
-- DOCUMENTS (uploaded files)
-- ═══════════════════════════════════════
CREATE TABLE documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  debtor_id UUID REFERENCES debtors(id) ON DELETE CASCADE NOT NULL,
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL, -- Supabase storage path
  file_size INT,
  doc_type TEXT, -- 'bank_analysis', 'dcr', 'lexisnexis', 'correspondence', 'invoice', 'contract'
  processed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════════════════════════════
-- TIMELINE (comms and events)
-- ═══════════════════════════════════════
CREATE TABLE timeline (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  debtor_id UUID REFERENCES debtors(id) ON DELETE CASCADE NOT NULL,
  sequence_day INT,
  channel TEXT NOT NULL CHECK (channel IN ('email','call','sms','whatsapp','letter','payment','legal','system')),
  direction TEXT DEFAULT 'out' CHECK (direction IN ('in','out')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','scheduled','sent','delivered','opened','replied','answered','voicemail','skipped','failed')),
  result TEXT, -- 'opened', 'voicemail', 'paid_full', 'partial_paid', 'sequence_paused', etc.
  summary TEXT,
  transcript TEXT, -- For AI calls
  metadata JSONB DEFAULT '{}', -- Stripe payment ID, email message ID, Twilio SID, etc.
  scheduled_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════════════════════════════
-- PAYMENTS
-- ═══════════════════════════════════════
CREATE TABLE payments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  debtor_id UUID REFERENCES debtors(id) ON DELETE CASCADE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  stripe_payment_intent_id TEXT,
  stripe_checkout_session_id TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','refunded')),
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════
CREATE INDEX idx_debtors_client ON debtors(client_id);
CREATE INDEX idx_debtors_status ON debtors(status);
CREATE INDEX idx_debtors_type ON debtors(type);
CREATE INDEX idx_timeline_debtor ON timeline(debtor_id);
CREATE INDEX idx_timeline_scheduled ON timeline(scheduled_at) WHERE status = 'scheduled';
CREATE INDEX idx_documents_debtor ON documents(debtor_id);
CREATE INDEX idx_payments_debtor ON payments(debtor_id);

-- ═══════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════
ALTER TABLE debtors ENABLE ROW LEVEL SECURITY;
ALTER TABLE timeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- Admin sees everything
CREATE POLICY "admin_all" ON debtors FOR ALL
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "admin_all" ON timeline FOR ALL
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "admin_all" ON documents FOR ALL
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "admin_all" ON intelligence FOR ALL
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "admin_all" ON payments FOR ALL
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));

-- Manager sees their client's debtors
CREATE POLICY "manager_read" ON debtors FOR SELECT
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'manager' AND client_id = debtors.client_id));

CREATE POLICY "manager_read" ON timeline FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM users u JOIN debtors d ON d.client_id = u.client_id
    WHERE u.id = auth.uid() AND u.role = 'manager' AND d.id = timeline.debtor_id
  ));

-- ═══════════════════════════════════════
-- SEED DATA
-- ═══════════════════════════════════════
INSERT INTO clients (id, name, contact_name, contact_email, color) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Revolution RTI', 'Dean Smith', 'dean@revolutionrti.co.uk', '#a855f7'),
  ('00000000-0000-0000-0000-000000000002', 'Zenith Legal', 'Jamie Anderson', 'jamie@zenith.legal', '#3b82f6');

-- ═══════════════════════════════════════
-- FUNCTIONS
-- ═══════════════════════════════════════

-- Calculate live amount for commercial debtors (principal + accrued interest - payments)
CREATE OR REPLACE FUNCTION calc_live_amount(d debtors)
RETURNS DECIMAL AS $$
BEGIN
  IF d.type = 'cvl' THEN
    RETURN GREATEST(0, d.base_amount - d.payments);
  ELSE
    RETURN GREATEST(0, d.principal + (d.daily_interest * GREATEST(0, EXTRACT(DAY FROM (now() - d.invoice_date::timestamptz)))) - d.payments);
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER debtors_updated
  BEFORE UPDATE ON debtors
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();
