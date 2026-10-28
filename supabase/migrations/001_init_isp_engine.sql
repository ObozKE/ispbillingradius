-- ==============================================================================
-- 001_init_isp_engine.sql
-- Enterprise ISP Bandwidth & FreeRADIUS Provisioning Engine Migration
-- ==============================================================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Create Transaction Status Enum
DO $$ BEGIN
  CREATE TYPE public.tx_status AS ENUM ('PENDING', 'COMPLETED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 2. Table: bandwidth_plans
CREATE TABLE IF NOT EXISTS public.bandwidth_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  price_kes INTEGER NOT NULL CHECK (price_kes > 0),
  rate_limit TEXT NOT NULL, -- e.g. '10M/10M', '50M/50M'
  vlan_id INTEGER NOT NULL CHECK (vlan_id BETWEEN 1 AND 4094),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Table: subscribers
CREATE TABLE IF NOT EXISTS public.subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE, -- PPPoE or IPoE login, e.g. 'cust_001'
  phone_number TEXT NOT NULL,     -- MSISDN e.g. '254712345678'
  ip_address TEXT NOT NULL,       -- Framed-IP-Address e.g. '10.10.100.50'
  current_plan_id UUID NOT NULL REFERENCES public.bandwidth_plans(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Table: mpesa_transactions
CREATE TABLE IF NOT EXISTS public.mpesa_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_request_id TEXT NOT NULL UNIQUE,
  merchant_request_id TEXT,
  mpesa_receipt_number TEXT UNIQUE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  phone_number TEXT NOT NULL,
  status public.tx_status NOT NULL DEFAULT 'PENDING',
  radius_provisioned BOOLEAN NOT NULL DEFAULT FALSE,
  subscriber_id UUID NOT NULL REFERENCES public.subscribers(id) ON DELETE CASCADE,
  target_plan_id UUID NOT NULL REFERENCES public.bandwidth_plans(id) ON DELETE RESTRICT,
  raw_callback_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Indices for performance & idempotency lookups
CREATE INDEX IF NOT EXISTS idx_mpesa_tx_checkout ON public.mpesa_transactions(checkout_request_id);
CREATE INDEX IF NOT EXISTS idx_mpesa_tx_receipt ON public.mpesa_transactions(mpesa_receipt_number);
CREATE INDEX IF NOT EXISTS idx_mpesa_tx_subscriber ON public.mpesa_transactions(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_subscribers_username ON public.subscribers(username);

-- 5. Row Level Security (RLS)
ALTER TABLE public.bandwidth_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mpesa_transactions ENABLE ROW LEVEL SECURITY;

-- Allow public read access for NOC dashboard telemetry & self-service demonstration
DROP POLICY IF EXISTS "Public plans viewable by all" ON public.bandwidth_plans;
CREATE POLICY "Public plans viewable by all" ON public.bandwidth_plans
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public subscribers viewable by all" ON public.subscribers;
CREATE POLICY "Public subscribers viewable by all" ON public.subscribers
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public transactions viewable by all" ON public.mpesa_transactions;
CREATE POLICY "Public transactions viewable by all" ON public.mpesa_transactions
  FOR SELECT USING (true);

-- Service role full access policies
DROP POLICY IF EXISTS "Service role full access plans" ON public.bandwidth_plans;
CREATE POLICY "Service role full access plans" ON public.bandwidth_plans
  FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role full access subscribers" ON public.subscribers;
CREATE POLICY "Service role full access subscribers" ON public.subscribers
  FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role full access transactions" ON public.mpesa_transactions;
CREATE POLICY "Service role full access transactions" ON public.mpesa_transactions
  FOR ALL USING (auth.role() = 'service_role');

-- Enable Realtime for live provisioning stream
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.bandwidth_plans;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.subscribers;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.mpesa_transactions;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 6. ACID Idempotent Stored Procedure: complete_mpesa_provisioning
CREATE OR REPLACE FUNCTION public.complete_mpesa_provisioning(
  p_checkout_request_id TEXT,
  p_mpesa_receipt TEXT,
  p_raw_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx public.mpesa_transactions%ROWTYPE;
  v_plan public.bandwidth_plans%ROWTYPE;
BEGIN
  -- 1. Lock the transaction row FOR UPDATE to prevent race conditions
  SELECT * INTO v_tx
  FROM public.mpesa_transactions
  WHERE checkout_request_id = p_checkout_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'TX_NOT_FOUND',
      'message', 'Transaction with checkout_request_id ' || p_checkout_request_id || ' not found'
    );
  END IF;

  -- 2. Idempotency check: Already processed?
  IF v_tx.status = 'COMPLETED' AND v_tx.radius_provisioned = true THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'ALREADY_COMPLETED',
      'message', 'Transaction was already completed and RADIUS provisioned',
      'transaction_id', v_tx.id,
      'subscriber_id', v_tx.subscriber_id,
      'target_plan_id', v_tx.target_plan_id
    );
  END IF;

  -- 3. Verify target bandwidth plan
  SELECT * INTO v_plan
  FROM public.bandwidth_plans
  WHERE id = v_tx.target_plan_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PLAN_NOT_FOUND',
      'message', 'Target bandwidth plan does not exist'
    );
  END IF;

  -- 4. Mark transaction as COMPLETED and radius_provisioned = true
  UPDATE public.mpesa_transactions
  SET
    status = 'COMPLETED',
    radius_provisioned = true,
    mpesa_receipt_number = COALESCE(p_mpesa_receipt, mpesa_receipt_number),
    raw_callback_payload = COALESCE(p_raw_payload, raw_callback_payload),
    completed_at = NOW()
  WHERE id = v_tx.id;

  -- 5. Atomically upgrade the subscriber profile in the database
  UPDATE public.subscribers
  SET
    current_plan_id = v_tx.target_plan_id,
    updated_at = NOW()
  WHERE id = v_tx.subscriber_id;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'PROVISION_SUCCESS',
    'message', 'Transaction committed and subscriber link upgraded atomically',
    'transaction_id', v_tx.id,
    'subscriber_id', v_tx.subscriber_id,
    'new_plan_id', v_plan.id,
    'new_rate_limit', v_plan.rate_limit,
    'new_vlan_id', v_plan.vlan_id
  );
END;
$$;

-- 7. Seed Data: Initial ISP Plans & Test Subscriber
INSERT INTO public.bandwidth_plans (id, name, price_kes, rate_limit, vlan_id, description)
VALUES 
  ('11111111-1111-1111-1111-111111111111', 'Home Fiber 10 Mbps', 2500, '10M/10M', 100, 'Entry-level residential fiber broadband with symmetric 10M rate-limit'),
  ('22222222-2222-2222-2222-222222222222', 'Business Fiber 50 Mbps', 4500, '50M/50M', 200, 'High-speed business tier with priority VLAN tag 200 and low latency routing'),
  ('33333333-3333-3333-3333-333333333333', 'Enterprise Fiber 100 Mbps', 8500, '100M/100M', 300, 'Dedicated enterprise symmetrical fiber with 24/7 SLA')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  price_kes = EXCLUDED.price_kes,
  rate_limit = EXCLUDED.rate_limit,
  vlan_id = EXCLUDED.vlan_id,
  description = EXCLUDED.description;

INSERT INTO public.subscribers (id, username, phone_number, ip_address, current_plan_id, updated_at)
VALUES (
  '99999999-9999-9999-9999-999999999999',
  'cust_001',
  '254712345678',
  '10.10.100.50',
  '11111111-1111-1111-1111-111111111111',
  NOW()
)
ON CONFLICT (username) DO UPDATE SET
  phone_number = EXCLUDED.phone_number,
  ip_address = EXCLUDED.ip_address,
  current_plan_id = EXCLUDED.current_plan_id,
  updated_at = NOW();
