'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity,
  Wifi,
  Server,
  Radio,
  ShieldCheck,
  Zap,
  Terminal,
  CheckCircle2,
  Clock,
  AlertCircle,
  RefreshCw,
  ArrowUpRight,
  Smartphone,
  ChevronRight,
  Gauge,
  Lock,
  Layers,
  Sparkles,
} from 'lucide-react';
import { supabaseBrowser, BandwidthPlan, Subscriber, MpesaTransaction } from '@/lib/supabase';

interface TelemetryStatus {
  subscriber: Subscriber;
  plans: BandwidthPlan[];
  transactions: MpesaTransaction[];
  auditLogs: Array<{
    timestamp: string;
    stage: string;
    message: string;
    metadata?: Record<string, unknown>;
  }>;
  config: {
    radiusDryRun: boolean;
    radiusHost: string;
    nasIp: string;
    darajaEnv: string;
  };
}

export default function TelecomNocPortal() {
  const [data, setData] = useState<TelemetryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeTxId, setActiveTxId] = useState<string | null>(null);

  // Upgrade Modal State
  const [selectedPlan, setSelectedPlan] = useState<BandwidthPlan | null>(null);
  const [phoneNumber, setPhoneNumber] = useState('254712345678');
  const [isSubmittingStk, setIsSubmittingStk] = useState(false);
  const [stkMessage, setStkMessage] = useState<string | null>(null);
  const [isSimulatingCallback, setIsSimulatingCallback] = useState(false);

  // Console Logs
  const [consoleLogs, setConsoleLogs] = useState<string[]>([
    `[NOC-INIT] Safaricom Fiber Automated Provisioning Gateway online`,
    `[RADIUS] Red Hat Enterprise Linux 9 FreeRADIUS daemon listening on UDP 1812/1813`,
    `[RFC-5176] BRAS Change of Authorization (CoA) listener ready on UDP 3799`,
  ]);

  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Append formatted log
  const pushLog = useCallback((msg: string) => {
    const time = new Date().toISOString().substring(11, 19);
    setConsoleLogs((prev) => [...prev, `[${time}] ${msg}`]);
  }, []);

  // Fetch full status
  const fetchStatus = useCallback(async (quiet = false) => {
    if (!quiet) setIsRefreshing(true);
    try {
      const res = await fetch('/api/isp/status');
      if (res.ok) {
        const json = await res.json();
        setData(json);

        // Check if there's any pending transaction
        const pending = json.transactions?.find((t: MpesaTransaction) => t.status === 'PENDING');
        if (pending) {
          setActiveTxId(pending.checkout_request_id);
        } else if (activeTxId) {
          // If transaction transitioned to completed
          const recentCompleted = json.transactions?.find(
            (t: MpesaTransaction) => t.checkout_request_id === activeTxId && t.status === 'COMPLETED'
          );
          if (recentCompleted) {
            pushLog(`[PIPELINE] Transaction ${activeTxId} successfully finalized!`);
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch status:', err);
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [activeTxId, pushLog]);

  // Initial load & Polling backup (every 2.5s)
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(() => {
      fetchStatus(true);
    }, 2500);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Supabase Realtime Subscription
  useEffect(() => {
    pushLog('[REALTIME] Subscribing to Supabase Realtime postgres_changes channel...');

    try {
      const channel = supabaseBrowser
        .channel('isp_noc_realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'mpesa_transactions' },
          (payload) => {
            pushLog(`[REALTIME-TX] Event: ${payload.eventType} for Transaction ${(payload.new as MpesaTransaction)?.checkout_request_id || ''}`);
            fetchStatus(true);
          }
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'subscribers' },
          (payload) => {
            pushLog(`[REALTIME-SUB] Subscriber updated! Plan: ${(payload.new as Subscriber)?.current_plan_id}`);
            fetchStatus(true);
          }
        )
        .subscribe((status) => {
          pushLog(`[REALTIME] Channel status: ${status}`);
        });

      return () => {
        supabaseBrowser.removeChannel(channel);
      };
    } catch (e) {
      console.warn('Realtime subscription error (polling active):', e);
    }
  }, [fetchStatus, pushLog]);

  // Auto-scroll terminal
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [consoleLogs]);

  // Handle STK Push Submission
  const handleInitiateUpgrade = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPlan || !data?.subscriber) return;

    setIsSubmittingStk(true);
    setStkMessage('Connecting to Safaricom Daraja M-Pesa Gateway...');
    pushLog(`[STK-PUSH] Initiating Daraja request for ${data.subscriber.username} -> Plan: ${selectedPlan.name} (KES ${selectedPlan.price_kes})`);

    try {
      const res = await fetch('/api/mpesa/stkpush', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscriberId: data.subscriber.id,
          targetPlanId: selectedPlan.id,
          phoneNumber: phoneNumber,
        }),
      });

      const json = await res.json();
      if (res.ok && json.success) {
        setActiveTxId(json.checkoutRequestId);
        setStkMessage(`STK Push dispatched to ${phoneNumber}! Prompt sent to mobile screen.`);
        pushLog(`[STAGE-1] STK Push Dispatched! CheckoutRequestID: ${json.checkoutRequestId}`);
        pushLog(`[STAGE-1] Awaiting subscriber PIN authorization or instant webhook callback.`);
        setSelectedPlan(null);
        fetchStatus(true);
      } else {
        setStkMessage(`Failed: ${json.error || 'Request rejected'}`);
        pushLog(`[STK-ERR] ${json.error}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setStkMessage(`Error: ${msg}`);
      pushLog(`[STK-EXC] ${msg}`);
    } finally {
      setIsSubmittingStk(false);
    }
  };

  // Simulate Instant Callback from Daraja
  const handleSimulateCallback = async (resultCode = 0) => {
    if (!activeTxId) return;

    setIsSimulatingCallback(true);
    pushLog(`[LAB-SIM] Generating authentic Daraja webhook payload for ${activeTxId} (ResultCode: ${resultCode})...`);

    try {
      const res = await fetch('/api/mpesa/simulate-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          checkoutRequestId: activeTxId,
          resultCode,
          phoneNumber,
        }),
      });

      const json = await res.json();
      if (res.ok && json.success) {
        if (resultCode === 0) {
          pushLog(`[STAGE-2] Daraja Webhook Received & ACID Idempotency Verified (Receipt: ${json.receiptNumber})`);
          pushLog(`[STAGE-3] SSH -> RHEL FreeRADIUS CoA Packet (UDP 3799) executed successfully! Output: PROVISION_OK`);
          pushLog(`[STAGE-4] Supabase RPC Ledger Committed — Link Upgraded to ${json.callbackResult?.subscriber?.current_plan?.rate_limit || 'new tier'}`);
        } else {
          pushLog(`[STAGE-2] Webhook received: User cancelled STK prompt (ResultCode ${resultCode})`);
        }
        await fetchStatus(true);
      } else {
        pushLog(`[SIM-ERR] Simulation failed: ${json.error}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error';
      pushLog(`[SIM-EXC] ${msg}`);
    } finally {
      setIsSimulatingCallback(false);
    }
  };

  // Reset to 10 Mbps Base Plan
  const handleResetDemo = async () => {
    pushLog('[DEMO-RESET] Reverting subscriber back to Home Fiber 10 Mbps (VLAN 100)...');
    try {
      const res = await fetch('/api/isp/reset', { method: 'POST' });
      if (res.ok) {
        setActiveTxId(null);
        await fetchStatus(true);
        pushLog('[DEMO-RESET] Subscriber profile reset successfully.');
      }
    } catch {
      pushLog('[DEMO-RESET] Failed to reset subscriber.');
    }
  };

  const subscriber = data?.subscriber;
  const currentPlan = subscriber?.current_plan || data?.plans[0];
  const pendingTx = data?.transactions?.find((t) => t.status === 'PENDING');

  // Compute speed gauge numeric
  const getSpeedNumeric = (rateLimit = '10M/10M') => {
    const match = rateLimit.match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : 10;
  };

  const speedVal = getSpeedNumeric(currentPlan?.rate_limit);
  const gaugePercent = Math.min(100, Math.max(10, (speedVal / 100) * 100));

  return (
    <div className="min-h-screen bg-[#030712] text-slate-100 flex flex-col font-sans">
      {/* Top Navigation & Status Banner */}
      <header className="border-b border-slate-800/80 bg-slate-950/60 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Radio className="w-5 h-5 text-slate-950 font-bold" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-extrabold tracking-wider text-sm sm:text-base bg-gradient-to-r from-emerald-400 via-teal-300 to-cyan-400 bg-clip-text text-transparent">
                  SAFARICOM FIBER NOC
                </span>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  AAA / RADIUS
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-mono hidden sm:block">
                RFC 5176 CoA Dynamic Provisioning Engine & M-Pesa Ledger
              </p>
            </div>
          </div>

          {/* Infrastructure Health Badges */}
          <div className="flex items-center space-x-2 sm:space-x-3">
            <div className="hidden md:flex items-center space-x-2 bg-slate-900/80 border border-slate-800 rounded-lg px-3 py-1.5 text-xs font-mono">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-slate-400">RHEL FreeRADIUS:</span>
              <span className="text-emerald-400 font-semibold">
                {data?.config.radiusDryRun ? 'DRY-RUN (Active)' : 'ONLINE'}
              </span>
            </div>

            <div className="hidden lg:flex items-center space-x-2 bg-slate-900/80 border border-slate-800 rounded-lg px-3 py-1.5 text-xs font-mono">
              <Server className="w-3.5 h-3.5 text-cyan-400" />
              <span className="text-slate-400">NAS CoA:</span>
              <span className="text-cyan-300">UDP 3799</span>
            </div>

            <button
              onClick={() => fetchStatus()}
              disabled={isRefreshing}
              className="flex items-center space-x-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-750 text-slate-300 hover:text-white px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer"
              title="Refresh telemetry"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-emerald-400' : ''}`} />
              <span className="hidden sm:inline">Refresh</span>
            </button>

            <button
              onClick={handleResetDemo}
              className="bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 hover:border-red-500/40 px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer"
            >
              Reset Demo (10M)
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* SECTION 1: Active Subscriber Telemetry Header */}
        <section className="relative overflow-hidden rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-900/90 to-slate-950/90 p-6 sm:p-8 backdrop-blur-xl shadow-2xl">
          <div className="absolute top-0 right-0 w-96 h-96 bg-emerald-500/5 rounded-full blur-3xl -z-10 pointer-events-none" />

          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
            {/* Subscriber Credentials & Session Details */}
            <div className="space-y-4 flex-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  PPPoE SESSION ACTIVE
                </span>
                <span className="px-2.5 py-1 rounded-md text-xs font-mono bg-slate-800 text-slate-300 border border-slate-700">
                  User: <strong className="text-white">{subscriber?.username || 'cust_001'}</strong>
                </span>
                <span className="px-2.5 py-1 rounded-md text-xs font-mono bg-slate-800 text-slate-300 border border-slate-700">
                  Framed-IP: <strong className="text-cyan-300">{subscriber?.ip_address || '10.10.100.50'}</strong>
                </span>
              </div>

              <div>
                <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                  {currentPlan?.name || 'Home Fiber 10 Mbps'}
                </h1>
                <p className="text-slate-400 text-sm mt-1">
                  Active Subscriber: <span className="text-slate-200">{subscriber?.phone_number || '254712345678'}</span> • NAS Group: <span className="text-cyan-400 font-mono">BRAS-NAIROBI-CORE-01</span>
                </p>
              </div>

              {/* Network Parameters Matrix */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
                <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3">
                  <div className="text-[11px] font-mono text-slate-400 uppercase">Rate-Limit Profile</div>
                  <div className="text-lg font-bold text-emerald-400 font-mono mt-0.5">
                    {currentPlan?.rate_limit || '10M/10M'}
                  </div>
                  <div className="text-[10px] text-slate-500">Mikrotik-Rate-Limit</div>
                </div>

                <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3">
                  <div className="text-[11px] font-mono text-slate-400 uppercase">VLAN ID</div>
                  <div className="text-lg font-bold text-cyan-400 font-mono mt-0.5">
                    TAG {currentPlan?.vlan_id || 100}
                  </div>
                  <div className="text-[10px] text-slate-500">Tunnel-Private-Group-Id</div>
                </div>

                <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3">
                  <div className="text-[11px] font-mono text-slate-400 uppercase">Billing Tier</div>
                  <div className="text-lg font-bold text-white font-mono mt-0.5">
                    KES {currentPlan?.price_kes.toLocaleString() || '2,500'}/mo
                  </div>
                  <div className="text-[10px] text-slate-500">Daraja STK Linked</div>
                </div>

                <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3">
                  <div className="text-[11px] font-mono text-slate-400 uppercase">AAA State</div>
                  <div className="text-lg font-bold text-teal-300 font-mono mt-0.5 flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" />
                    IN SYNC
                  </div>
                  <div className="text-[10px] text-slate-500">FreeRADIUS /etc/raddb</div>
                </div>
              </div>
            </div>

            {/* Bandwidth Speed Gauge */}
            <div className="w-full lg:w-72 bg-slate-950/80 border border-slate-800 rounded-2xl p-5 flex flex-col items-center justify-center relative shadow-inner">
              <div className="flex items-center justify-between w-full mb-2">
                <span className="text-xs font-mono text-slate-400 flex items-center gap-1.5">
                  <Gauge className="w-3.5 h-3.5 text-emerald-400" />
                  SUBSCRIBER BANDWIDTH
                </span>
                <span className="text-xs font-mono text-emerald-400 font-bold">SYMMETRIC</span>
              </div>

              {/* Gauge Graphic */}
              <div className="relative w-40 h-40 flex items-center justify-center my-1">
                <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                  <circle
                    cx="50"
                    cy="50"
                    r="40"
                    stroke="#1e293b"
                    strokeWidth="8"
                    fill="transparent"
                  />
                  <motion.circle
                    cx="50"
                    cy="50"
                    r="40"
                    stroke="url(#speedGradient)"
                    strokeWidth="8"
                    fill="transparent"
                    strokeDasharray="251.2"
                    initial={{ strokeDashoffset: 251.2 }}
                    animate={{ strokeDashoffset: 251.2 - (251.2 * gaugePercent) / 100 }}
                    transition={{ duration: 1.2, ease: 'easeOut' }}
                    strokeLinecap="round"
                  />
                  <defs>
                    <linearGradient id="speedGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#10b981" />
                      <stop offset="50%" stopColor="#06b6d4" />
                      <stop offset="100%" stopColor="#3b82f6" />
                    </linearGradient>
                  </defs>
                </svg>

                <div className="absolute flex flex-col items-center justify-center text-center">
                  <motion.span
                    key={currentPlan?.rate_limit}
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="text-3xl font-extrabold text-white font-mono"
                  >
                    {speedVal}
                  </motion.span>
                  <span className="text-[11px] font-mono text-slate-400 uppercase tracking-wider">Mbps Speed</span>
                </div>
              </div>

              <div className="w-full grid grid-cols-2 gap-2 text-center text-xs font-mono pt-1">
                <div className="bg-slate-900/90 rounded-lg py-1 border border-slate-800">
                  <span className="text-slate-400 text-[10px]">DOWN:</span>{' '}
                  <span className="text-emerald-400 font-bold">{speedVal} Mbps</span>
                </div>
                <div className="bg-slate-900/90 rounded-lg py-1 border border-slate-800">
                  <span className="text-slate-400 text-[10px]">UP:</span>{' '}
                  <span className="text-cyan-400 font-bold">{speedVal} Mbps</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 2: Self-Service Bandwidth Plan Upgrade Cards */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Zap className="w-5 h-5 text-amber-400" />
                Available Fiber Bandwidth Plans
              </h2>
              <p className="text-slate-400 text-xs sm:text-sm">
                Instant self-service upgrade powered by Safaricom Daraja STK Push & FreeRADIUS CoA
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {data?.plans?.map((plan) => {
              const isCurrent = subscriber?.current_plan_id === plan.id;
              const isPending = pendingTx && pendingTx.target_plan_id === plan.id;

              return (
                <div
                  key={plan.id}
                  className={`relative rounded-2xl border transition-all duration-300 flex flex-col justify-between overflow-hidden ${
                    isCurrent
                      ? 'border-emerald-500/60 bg-emerald-950/20 shadow-lg shadow-emerald-950/30 ring-1 ring-emerald-500/30'
                      : 'border-slate-800 bg-slate-900/50 hover:border-slate-700 hover:bg-slate-900/80'
                  }`}
                >
                  {isCurrent && (
                    <div className="bg-emerald-500 text-slate-950 text-[11px] font-bold py-1 px-3 text-center uppercase tracking-wider flex items-center justify-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Active Subscription
                    </div>
                  )}

                  {isPending && (
                    <div className="bg-amber-500 text-slate-950 text-[11px] font-bold py-1 px-3 text-center uppercase tracking-wider flex items-center justify-center gap-1.5 animate-pulse">
                      <Clock className="w-3.5 h-3.5" />
                      STK Authorization Pending
                    </div>
                  )}

                  <div className="p-6 space-y-4">
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="text-lg font-bold text-white">{plan.name}</h3>
                        <p className="text-xs text-slate-400 mt-0.5">{plan.description}</p>
                      </div>
                      <div className="w-9 h-9 rounded-lg bg-slate-800 flex items-center justify-center border border-slate-700">
                        <Wifi className={`w-5 h-5 ${isCurrent ? 'text-emerald-400' : 'text-slate-400'}`} />
                      </div>
                    </div>

                    <div className="pt-2">
                      <div className="flex items-baseline space-x-1">
                        <span className="text-xs font-mono text-slate-400">KES</span>
                        <span className="text-3xl font-extrabold text-white font-mono">
                          {plan.price_kes.toLocaleString()}
                        </span>
                        <span className="text-xs text-slate-400">/month</span>
                      </div>
                    </div>

                    {/* Technical Specifications */}
                    <div className="space-y-2 pt-2 border-t border-slate-800/80 text-xs font-mono">
                      <div className="flex justify-between py-1 border-b border-slate-800/40">
                        <span className="text-slate-400">Rate Limit:</span>
                        <span className="text-emerald-400 font-bold">{plan.rate_limit}</span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-slate-800/40">
                        <span className="text-slate-400">VLAN Tag:</span>
                        <span className="text-cyan-400 font-bold">VLAN {plan.vlan_id}</span>
                      </div>
                      <div className="flex justify-between py-1">
                        <span className="text-slate-400">Provisioning Mode:</span>
                        <span className="text-slate-200">Instant RFC 5176 CoA</span>
                      </div>
                    </div>
                  </div>

                  <div className="p-6 pt-0">
                    {isCurrent ? (
                      <button
                        disabled
                        className="w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 cursor-default"
                      >
                        Current Plan
                      </button>
                    ) : (
                      <button
                        onClick={() => setSelectedPlan(plan)}
                        className="w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-bold shadow-lg shadow-emerald-600/20 hover:shadow-emerald-500/30 transition flex items-center justify-center gap-2 cursor-pointer"
                      >
                        <Smartphone className="w-4 h-4" />
                        Upgrade with M-Pesa
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* SECTION 3: Provisioning Pipeline State Tracker & Live Console */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* 4-Stage State Pipeline Tracker */}
          <div className="lg:col-span-5 space-y-4">
            <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-md">
              <h3 className="text-base font-bold text-white flex items-center gap-2 mb-4">
                <Layers className="w-4 h-4 text-cyan-400" />
                Live Provisioning Pipeline State
              </h3>

              <div className="space-y-4">
                {/* Step 1 */}
                <div
                  className={`p-3.5 rounded-xl border transition ${
                    activeTxId || data?.transactions?.length
                      ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-300'
                      : 'border-slate-800 bg-slate-950/50 text-slate-400'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-bold font-mono">
                    <span className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-[10px]">
                        1
                      </span>
                      [1] STK Push Dispatched
                    </span>
                    <span className="text-[10px] text-emerald-400 font-normal">Safaricom Daraja API</span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1 pl-7">
                    Customer receives Lipa Na M-Pesa prompt on mobile screen.
                  </p>
                </div>

                {/* Step 2 */}
                <div
                  className={`p-3.5 rounded-xl border transition ${
                    data?.transactions?.[0]?.status === 'COMPLETED'
                      ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-300'
                      : activeTxId
                      ? 'border-amber-500/40 bg-amber-950/20 text-amber-300 animate-pulse'
                      : 'border-slate-800 bg-slate-950/50 text-slate-400'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-bold font-mono">
                    <span className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center text-[10px]">
                        2
                      </span>
                      [2] Webhook & Idempotency Lock
                    </span>
                    <span className="text-[10px] text-cyan-400 font-normal">PostgreSQL FOR UPDATE</span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1 pl-7">
                    Safaricom callback parsed. Duplicate requests rejected idempotently.
                  </p>
                </div>

                {/* Step 3 */}
                <div
                  className={`p-3.5 rounded-xl border transition ${
                    data?.transactions?.[0]?.radius_provisioned
                      ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-300'
                      : activeTxId
                      ? 'border-slate-800 bg-slate-950/50 text-slate-400'
                      : 'border-slate-800 bg-slate-950/50 text-slate-400'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-bold font-mono">
                    <span className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-[10px]">
                        3
                      </span>
                      [3] SSH & FreeRADIUS CoA
                    </span>
                    <span className="text-[10px] text-indigo-400 font-normal">UDP 3799 RFC 5176</span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1 pl-7">
                    Rate-limit updated in /etc/raddb & CoA packet dispatched to BRAS.
                  </p>
                </div>

                {/* Step 4 */}
                <div
                  className={`p-3.5 rounded-xl border transition ${
                    data?.transactions?.[0]?.status === 'COMPLETED'
                      ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-300'
                      : 'border-slate-800 bg-slate-950/50 text-slate-400'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-bold font-mono">
                    <span className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-[10px]">
                        4
                      </span>
                      [4] Supabase RPC Ledger Committed
                    </span>
                    <span className="text-[10px] text-emerald-400 font-normal">Realtime Broadcast</span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1 pl-7">
                    Subscribers table updated. Link speed upgraded live without PPPoE reconnect.
                  </p>
                </div>
              </div>

              {/* SECTION 4: Developer Lab Simulation Controls */}
              <div className="mt-6 pt-5 border-t border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono font-bold text-slate-300 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                    DEVELOPER SIMULATION LAB
                  </span>
                  {activeTxId && (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse">
                      Pending STK: {activeTxId.substring(0, 15)}...
                    </span>
                  )}
                </div>

                <p className="text-xs text-slate-400">
                  Simulate instant Safaricom webhook callback to test the automated FreeRADIUS provisioning pipeline:
                </p>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    onClick={() => handleSimulateCallback(0)}
                    disabled={!activeTxId || isSimulatingCallback}
                    className={`py-2 px-3 rounded-xl text-xs font-mono font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
                      activeTxId && !isSimulatingCallback
                        ? 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white shadow-lg shadow-emerald-600/20'
                        : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
                    }`}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {isSimulatingCallback ? 'Simulating...' : 'Simulate Success'}
                  </button>

                  <button
                    onClick={() => handleSimulateCallback(1032)}
                    disabled={!activeTxId || isSimulatingCallback}
                    className={`py-2 px-3 rounded-xl text-xs font-mono transition flex items-center justify-center gap-1.5 cursor-pointer ${
                      activeTxId && !isSimulatingCallback
                        ? 'bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30'
                        : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
                    }`}
                  >
                    <AlertCircle className="w-3.5 h-3.5" />
                    Simulate Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Real-Time Provisioning Console / Terminal */}
          <div className="lg:col-span-7 flex flex-col">
            <div className="bg-slate-950 border border-slate-800 rounded-2xl flex-1 flex flex-col overflow-hidden shadow-2xl">
              {/* Terminal Title Bar */}
              <div className="bg-slate-900/90 px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Terminal className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-mono font-bold text-slate-200">
                    PROVISIONING TELEMETRY STREAM
                  </span>
                </div>
                <div className="flex items-center space-x-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
                </div>
              </div>

              {/* Logs Screen */}
              <div className="p-4 flex-1 font-mono text-xs overflow-y-auto max-h-[380px] space-y-1.5 bg-[#050914] text-slate-300">
                {consoleLogs.map((log, idx) => {
                  let colorClass = 'text-slate-300';
                  if (log.includes('[STAGE-') || log.includes('[PROVISION_OK]')) {
                    colorClass = 'text-emerald-400 font-semibold';
                  } else if (log.includes('[CoA]') || log.includes('[RFC-5176]')) {
                    colorClass = 'text-cyan-300';
                  } else if (log.includes('[STK-PUSH]') || log.includes('[REALTIME')) {
                    colorClass = 'text-amber-300';
                  } else if (log.includes('ERR') || log.includes('FAILED') || log.includes('cancelled')) {
                    colorClass = 'text-red-400';
                  }

                  return (
                    <div key={idx} className={`leading-relaxed ${colorClass}`}>
                      {log}
                    </div>
                  );
                })}
                <div ref={terminalEndRef} />
              </div>

              {/* Terminal Footer */}
              <div className="bg-slate-900/50 px-4 py-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  SSH2 Daemon / FreeRADIUS CoA Daemon Listening
                </span>
                <span>Port 3799 / 1812</span>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 5: Recent Transactions Table */}
        <section className="bg-slate-900/50 border border-slate-800 rounded-2xl overflow-hidden backdrop-blur-md">
          <div className="p-5 border-b border-slate-800 flex items-center justify-between">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400" />
              M-Pesa Ledger & RADIUS Provisioning History
            </h3>
            <span className="text-xs font-mono text-slate-400">
              Total Records: {data?.transactions?.length || 0}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-slate-950/60 text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4 font-semibold">Checkout Request ID</th>
                  <th className="py-3 px-4 font-semibold">M-Pesa Receipt</th>
                  <th className="py-3 px-4 font-semibold">Amount</th>
                  <th className="py-3 px-4 font-semibold">Target Plan</th>
                  <th className="py-3 px-4 font-semibold">M-Pesa Status</th>
                  <th className="py-3 px-4 font-semibold">RADIUS CoA</th>
                  <th className="py-3 px-4 font-semibold">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-300">
                {(!data?.transactions || data.transactions.length === 0) ? (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-slate-500">
                      No M-Pesa transactions logged yet. Click &apos;Upgrade with M-Pesa&apos; above.
                    </td>
                  </tr>
                ) : (
                  data.transactions.map((tx) => (
                    <tr key={tx.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3 px-4 text-white font-medium">
                        {tx.checkout_request_id}
                      </td>
                      <td className="py-3 px-4 text-emerald-400">
                        {tx.mpesa_receipt_number || '—'}
                      </td>
                      <td className="py-3 px-4">
                        KES {tx.amount.toLocaleString()}
                      </td>
                      <td className="py-3 px-4 text-slate-200">
                        {tx.target_plan?.rate_limit || '50M/50M'} (VLAN {tx.target_plan?.vlan_id || 200})
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold ${
                            tx.status === 'COMPLETED'
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                              : tx.status === 'PENDING'
                              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse'
                              : 'bg-red-500/10 text-red-400 border border-red-500/20'
                          }`}
                        >
                          {tx.status}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        {tx.radius_provisioned ? (
                          <span className="text-emerald-400 flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" /> PROVISIONED
                          </span>
                        ) : (
                          <span className="text-slate-500 flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5" /> AWAITING
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-slate-400">
                        {new Date(tx.created_at).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* MODAL: M-Pesa STK Push Confirmation */}
      <AnimatePresence>
        {selectedPlan && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl relative"
            >
              <div className="flex items-center justify-between pb-4 border-b border-slate-800">
                <div className="flex items-center space-x-2.5">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                    <Smartphone className="w-4 h-4" />
                  </div>
                  <h3 className="font-bold text-white text-base">Confirm M-Pesa STK Push</h3>
                </div>
                <button
                  onClick={() => setSelectedPlan(null)}
                  className="text-slate-400 hover:text-white text-sm cursor-pointer"
                >
                  ✕
                </button>
              </div>

              <form onSubmit={handleInitiateUpgrade} className="space-y-4 pt-4">
                {/* Upgrade Summary */}
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2 text-xs font-mono">
                  <div className="flex justify-between">
                    <span className="text-slate-400">PPPoE User:</span>
                    <span className="text-white font-bold">{subscriber?.username}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Target Plan:</span>
                    <span className="text-emerald-400 font-bold">{selectedPlan.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">New Bandwidth:</span>
                    <span className="text-cyan-400 font-bold">{selectedPlan.rate_limit}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Target VLAN:</span>
                    <span className="text-indigo-400 font-bold">VLAN {selectedPlan.vlan_id}</span>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-slate-800">
                    <span className="text-slate-300 font-semibold">Total Amount:</span>
                    <span className="text-white font-bold text-sm">
                      KES {selectedPlan.price_kes.toLocaleString()}
                    </span>
                  </div>
                </div>

                {/* Phone Number Input */}
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Safaricom M-Pesa Phone Number
                  </label>
                  <input
                    type="text"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="2547XXXXXXXX"
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm font-mono text-white focus:outline-none focus:border-emerald-500"
                    required
                  />
                  <span className="text-[11px] text-slate-500 mt-1 block">
                    An STK prompt will appear on this phone prompting for the M-Pesa PIN.
                  </span>
                </div>

                {stkMessage && (
                  <div className="p-3 rounded-lg text-xs font-mono bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                    {stkMessage}
                  </div>
                )}

                <div className="flex items-center space-x-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setSelectedPlan(null)}
                    className="flex-1 py-2.5 px-4 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 transition cursor-pointer"
                  >
                    Cancel
                  </button>

                  <button
                    type="submit"
                    disabled={isSubmittingStk}
                    className="flex-1 py-2.5 px-4 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-slate-950 transition flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-emerald-600/30"
                  >
                    {isSubmittingStk ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Zap className="w-3.5 h-3.5" />
                    )}
                    {isSubmittingStk ? 'Sending...' : 'Authorize KES ' + selectedPlan.price_kes}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
