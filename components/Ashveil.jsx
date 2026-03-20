import { useState, useMemo, useEffect, useRef } from "react";
import { useUser, useClients, useUsers, useDebtors, signOut, generatePaymentLink, runIntelligence, uploadDocuments, sendEmail, sendSMS, makeCall, useHealth, createPaymentPlan } from "@/lib/hooks";
import ClientModal from "./ClientModal";
import UserModal from "./UserModal";

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════

const CHANNELS = {
  email: { icon: "✉", label: "Email", color: "#3b82f6", provider: "SendGrid" },
  call: { icon: "📞", label: "AI Call", color: "#a855f7", provider: "Vapi" },
  sms: { icon: "💬", label: "SMS", color: "#f59e0b", provider: "Twilio" },
  whatsapp: { icon: "📱", label: "WhatsApp", color: "#22c55e", provider: "Twilio" },
  letter: { icon: "📄", label: "Letter", color: "#6b7280", provider: "Royal Mail" },
  payment: { icon: "💷", label: "Payment", color: "#10b981", provider: "Stripe" },
  legal: { icon: "⚖️", label: "Legal", color: "#ef4444", provider: "Manual" },
};

const STATUS_CFG = {
  queued: { label: "Queued", color: "#6b7280", bg: "rgba(107,114,128,0.12)" },
  active: { label: "In Sequence", color: "#3b82f6", bg: "rgba(59,130,246,0.12)" },
  responding: { label: "Responding", color: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
  negotiating: { label: "Negotiating", color: "#a855f7", bg: "rgba(168,85,247,0.12)" },
  payment_plan: { label: "Payment Plan", color: "#22c55e", bg: "rgba(34,197,94,0.12)" },
  settled: { label: "Settled", color: "#10b981", bg: "rgba(16,185,129,0.12)" },
  disputed: { label: "Disputed", color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
  escalated: { label: "Escalated", color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
};

const PRI_CFG = {
  high: { label: "High", color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
  medium: { label: "Medium", color: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
  low: { label: "Low", color: "#6b7280", bg: "rgba(107,114,128,0.12)" },
};

const SEQUENCES = {
  high: { name: "High Value / Assets", steps: [
    { day: 1, channel: "email", action: "Formal demand with payment link", auto: true },
    { day: 1, channel: "payment", action: "Stripe link generated", auto: true },
    { day: 3, channel: "call", action: "AI call - professional tone", auto: true },
    { day: 5, channel: "sms", action: "SMS chase with payment link", auto: true },
    { day: 7, channel: "email", action: "Second demand - tone shift", auto: true },
    { day: 10, channel: "call", action: "AI call - firmer", auto: true },
    { day: 12, channel: "whatsapp", action: "WhatsApp - direct", auto: true },
    { day: 14, channel: "letter", action: "Posted pre-action letter", auto: false },
    { day: 21, channel: "call", action: "Final AI call", auto: true },
    { day: 28, channel: "legal", action: "Escalate to litigation", auto: false },
  ]},
  medium: { name: "Standard Recovery", steps: [
    { day: 1, channel: "email", action: "Formal demand", auto: true },
    { day: 1, channel: "payment", action: "Stripe link generated", auto: true },
    { day: 5, channel: "sms", action: "SMS reminder", auto: true },
    { day: 10, channel: "call", action: "AI call", auto: true },
    { day: 14, channel: "email", action: "Second demand", auto: true },
    { day: 21, channel: "call", action: "Second AI call", auto: true },
    { day: 28, channel: "letter", action: "Pre-legal letter", auto: false },
    { day: 42, channel: "legal", action: "Escalate", auto: false },
  ]},
  low: { name: "Light Touch", steps: [
    { day: 1, channel: "email", action: "Demand with payment link", auto: true },
    { day: 7, channel: "sms", action: "SMS reminder", auto: true },
    { day: 14, channel: "email", action: "Follow-up", auto: true },
    { day: 28, channel: "email", action: "Final demand", auto: true },
    { day: 42, channel: "legal", action: "Review for write-off", auto: false },
  ]},
};

const calcLiveAmount = (d) => {
  if (d.type === "cvl") return d.baseAmount - d.payments;
  // Commercial: principal + daily interest from invoice date
  const now = new Date("2026-03-19");
  const inv = new Date(d.invoiceDate + "T00:00:00");
  const days = Math.max(0, Math.floor((now - inv) / 86400000));
  const total = d.principal + (d.dailyInterest * days);
  return total - d.payments;
};

const calcTotalOwed = (d) => {
  if (d.type === "cvl") return d.baseAmount;
  const now = new Date("2026-03-19");
  const inv = new Date(d.invoiceDate + "T00:00:00");
  const days = Math.max(0, Math.floor((now - inv) / 86400000));
  return d.principal + (d.dailyInterest * days);
};

// ── Clients and user loaded from hooks in main component ──
let CLIENTS = [];
let CURRENT_USER = { name: "Loading...", role: "admin", email: "" };

const fmt = (n) => `£${Math.abs(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => { if (!d || d === "N/A") return "---"; const dt = new Date(d + "T00:00:00"); return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }); };

// ── Transform Supabase data to component format ──
function normalizeDebtor(d) {
  const intel = d.intelligence?.[0] || null;
  return {
    id: d.id, type: d.type, client: d.client_id, name: d.name, company: d.company,
    coNumber: d.co_number, baseAmount: parseFloat(d.base_amount) || 0,
    principal: parseFloat(d.principal) || 0, dailyInterest: parseFloat(d.daily_interest) || 79,
    invoiceDate: d.invoice_date, status: d.status, priority: d.priority,
    seqDay: d.sequence_day || 0, lastContact: d.last_contact || "N/A",
    nextAction: d.next_action || "Queued", payments: parseFloat(d.payments) || 0,
    phone: d.phone, email: d.email, address: d.address, dateAdded: d.created_at?.split("T")[0],
    stripeLink: d.stripe_payment_link_url,
    intel: intel ? {
      confidence: intel.confidence, claimStrength: intel.claim_strength,
      claims: intel.claims || [], assets: intel.assets || [], flags: intel.flags || [],
      breakdown: (intel.breakdown || []).map(b => ({ desc: b.desc, amt: b.amt })),
      docs: (d.documents || []).map(doc => doc.filename),
      legalBasis: (intel.claims || [])[0] || ""
    } : null,
    timeline: (d.timeline || []).map(t => ({
      day: t.sequence_day, channel: t.channel, status: t.status, direction: t.direction,
      result: t.result, ts: t.executed_at, transcript: t.transcript, summary: t.summary
    })),
    _raw: d, // Keep raw data for updates
  };
}

// ═══════════════════════════════════════════
// REUSABLE
// ═══════════════════════════════════════════

const Bar = ({ value, max, color, h = 6 }) => (
  <div style={{ width: "100%", height: h, background: "rgba(255,255,255,0.06)", borderRadius: h/2, overflow: "hidden" }}>
    <div style={{ width: `${Math.min((value/Math.max(max,1))*100, 100)}%`, height: "100%", background: color, borderRadius: h/2, transition: "width 0.8s cubic-bezier(0.4,0,0.2,1)" }} />
  </div>
);

const Badge = ({ label, color, bg }) => (
  <span style={{ padding: "3px 9px", borderRadius: 4, fontSize: 10, fontWeight: 600, color, background: bg, whiteSpace: "nowrap" }}>{label}</span>
);

const Stat = ({ label, value, sub, accent }) => (
  <div style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 10, padding: "18px 20px", flex: 1, minWidth: 150 }}>
    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 6, fontFamily: "var(--mono)" }}>{label}</div>
    <div style={{ fontSize: 24, fontWeight: 700, color: accent || "#fff", fontFamily: "var(--mono)", lineHeight: 1 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 5 }}>{sub}</div>}
  </div>
);

// ═══════════════════════════════════════════
// ADD DEBTOR MODAL
// ═══════════════════════════════════════════

const AddDebtorModal = ({ onClose, onAdd }) => {
  const [step, setStep] = useState(1);
  const [debtType, setDebtType] = useState(null); // "cvl" or "commercial"
  const [form, setForm] = useState({ client: "", name: "", company: "", coNumber: "", email: "", phone: "", address: "", principal: "", invoiceDate: "", dailyInterest: "79" });
  const [docs, setDocs] = useState([]);
  const [realFiles, setRealFiles] = useState([]); // actual File objects
  const [processing, setProcessing] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const [aiError, setAiError] = useState(null);
  const upd = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const inp = { width: "100%", padding: "10px 12px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: "#fff", fontSize: 13, fontFamily: "var(--body)", outline: "none", boxSizing: "border-box" };
  const lbl = { fontSize: 10, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4, display: "block", fontFamily: "var(--mono)" };
  const fileInputRef = useRef(null);

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || []);
    setRealFiles(prev => [...prev, ...files]);
    setDocs(prev => [...prev, ...files.map(f => ({ name: f.name, size: (f.size / 1024).toFixed(0) + " KB" }))]);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    setRealFiles(prev => [...prev, ...files]);
    setDocs(prev => [...prev, ...files.map(f => ({ name: f.name, size: (f.size / 1024).toFixed(0) + " KB" }))]);
  };

  const [progressMsg, setProgressMsg] = useState("");

  const runAI = async () => {
    setProcessing(true);
    setAiError(null);
    setProgressMsg("Uploading documents...");
    try {
      let documentsText = "";

      // Upload files to server for extraction
      if (realFiles.length > 0) {
        setProgressMsg(`Uploading ${realFiles.length} file${realFiles.length > 1 ? "s" : ""}...`);
        const formData = new FormData();
        formData.append("debtor_id", "temp_" + Date.now());
        realFiles.forEach(f => formData.append("files", f));

        const uploadRes = await fetch("/api/documents", { method: "POST", body: formData });

        if (!uploadRes.ok) {
          const errText = await uploadRes.text();
          throw new Error("Upload failed: " + errText.substring(0, 200));
        }

        const uploadData = await uploadRes.json();

        if (uploadData.error) throw new Error(uploadData.error);

        setProgressMsg(`${uploadData.file_count || realFiles.length} files processed. ${uploadData.truncated ? "Some content truncated. " : ""}Analysing...`);

        if (uploadData.extracted_text) {
          documentsText = uploadData.extracted_text;
        }
      }

      // Add form context
      if (debtType === "commercial") {
        documentsText += `\n\n--- Case Details ---\nPrincipal: £${form.principal}\nInvoice Date: ${form.invoiceDate}\nDaily Interest: £${form.dailyInterest}`;
      }
      if (debtType === "cvl") {
        documentsText += `\n\n--- Case Details ---\nDirector: ${form.name}\nCompany: ${form.company} (${form.coNumber})`;
      }

      if (!documentsText || documentsText.trim().length < 20) {
        setAiError("No readable text could be extracted. Check your PDFs aren't scanned images. Try uploading text files or a ZIP containing PDFs.");
        setProcessing(false);
        setProgressMsg("");
        return;
      }

      setProgressMsg("Claude is analysing your documents...");

      const result = await fetch("/api/intelligence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ debtor_id: null, type: debtType, documents_text: documentsText }),
      });

      if (!result.ok) {
        const errText = await result.text();
        throw new Error("Analysis failed: " + errText.substring(0, 200));
      }

      const data = await result.json();

      if (data.error) {
        throw new Error(data.error);
      }

      const analysis = data.analysis;
      setProgressMsg("");

      if (debtType === "cvl") {
        setAiResult({
          type: "cvl",
          confidence: analysis.confidence || 85,
          suggestedPriority: analysis.suggested_priority || "medium",
          claimStrength: analysis.claim_strength || "Moderate",
          totalRecoverable: analysis.total_recoverable || 0,
          claims: analysis.claims || [],
          assets: analysis.assets || [],
          flags: analysis.flags || [],
          breakdown: analysis.breakdown || [],
        });
      } else {
        const principal = analysis.principal || parseFloat(form.principal) || 0;
        const dailyRate = analysis.daily_interest || parseFloat(form.dailyInterest) || 79;
        const invDate = analysis.invoice_date || form.invoiceDate || new Date().toISOString().split("T")[0];
        const days = Math.max(0, Math.floor((new Date() - new Date(invDate + "T00:00:00")) / 86400000));
        setAiResult({
          type: "commercial",
          confidence: analysis.confidence || 90,
          suggestedPriority: analysis.suggested_priority || (days > 30 ? "high" : "medium"),
          claimStrength: analysis.claim_strength || "Strong - contractual",
          principal,
          dailyInterest: dailyRate,
          invoiceDate: invDate,
          daysOverdue: days,
          currentTotal: principal + (dailyRate * days),
          claims: analysis.claims || [],
          assets: analysis.assets || [],
          flags: analysis.flags || [],
          breakdown: analysis.breakdown || [],
        });
      }
      setStep(3);
    } catch (err) {
      console.error("AI analysis error:", err);
      setAiError(err.message || "Analysis failed. Try with fewer files or check your API key has credit.");
      setProgressMsg("");
    }
    setProcessing(false);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, backdropFilter: "blur(4px)" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#13132a", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, width: 580, maxHeight: "88vh", overflowY: "auto" }}>
        {/* Header */}
        <div style={{ padding: "18px 22px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16 }}>Add Debtor</h3>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 1 }}>{debtType ? (debtType === "cvl" ? "CVL Recovery" : "Commercial Debt") : "Select type"} {step > 0 && `- Step ${step}/3`}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            {[1,2,3].map(s => <div key={s} style={{ width: 7, height: 7, borderRadius: 4, background: s <= step ? "#3b82f6" : "rgba(255,255,255,0.06)" }} />)}
            <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.3)", fontSize: 17, cursor: "pointer", marginLeft: 10 }}>✕</button>
          </div>
        </div>

        <div style={{ padding: "18px 22px" }}>

          {/* STEP 1: Type + Details */}
          {step === 1 && (<div>
            {/* Type selector */}
            {!debtType && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
                {[
                  { id: "cvl", icon: "⚖️", title: "CVL Recovery", desc: "ODLAs, preferences, misfeasance, wrongful trading. AI determines recoverable from intelligence docs.", accent: "#a855f7" },
                  { id: "commercial", icon: "💷", title: "Commercial Debt", desc: "Unpaid invoices, contractual debts. Principal + daily interest. Live running total.", accent: "#3b82f6" },
                ].map(t => (
                  <button key={t.id} onClick={() => setDebtType(t.id)} style={{
                    padding: "20px 18px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)",
                    borderRadius: 10, cursor: "pointer", textAlign: "left", transition: "all 0.15s"
                  }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = t.accent + "44"; e.currentTarget.style.background = t.accent + "08"; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)"; e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
                  >
                    <div style={{ fontSize: 24, marginBottom: 8 }}>{t.icon}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: t.accent, marginBottom: 4 }}>{t.title}</div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", lineHeight: 1.5 }}>{t.desc}</div>
                  </button>
                ))}
              </div>
            )}

            {debtType && (
              <div>
                <button onClick={() => setDebtType(null)} style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", background: "none", border: "none", cursor: "pointer", marginBottom: 12, padding: 0 }}>← Change type</button>

                {/* Client selector - admin only */}
                {CURRENT_USER.role === "admin" && (
                  <div style={{ marginBottom: 14 }}>
                    <label style={lbl}>Client</label>
                    <select style={{ ...inp, appearance: "none" }} value={form.client} onChange={e => upd("client", e.target.value)}>
                      <option value="">Select client...</option>
                      {CLIENTS.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div><label style={lbl}>Director Name</label><input style={inp} value={form.name} onChange={e => upd("name", e.target.value)} placeholder="e.g. John Smith" /></div>
                  <div><label style={lbl}>Company Name</label><input style={inp} value={form.company} onChange={e => upd("company", e.target.value)} placeholder="e.g. Smith Ltd" /></div>
                  <div style={{ gridColumn: "1 / -1" }}><label style={lbl}>Company Number</label>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input style={{ ...inp, flex: 1 }} value={form.coNumber} onChange={e => upd("coNumber", e.target.value)} placeholder="12345678 (AI will pull company data)" />
                    </div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", marginTop: 4 }}>Claude will fetch company details, directors, and filings automatically</div>
                  </div>
                  <div><label style={lbl}>Email</label><input style={inp} value={form.email} onChange={e => upd("email", e.target.value)} placeholder="director@company.co.uk" /></div>
                  <div><label style={lbl}>Phone</label><input style={inp} value={form.phone} onChange={e => upd("phone", e.target.value)} placeholder="07700 000000" /></div>
                  <div style={{ gridColumn: "1 / -1" }}><label style={lbl}>Address</label><input style={inp} value={form.address} onChange={e => upd("address", e.target.value)} placeholder="Full address" /></div>

                  {/* Commercial-specific fields */}
                  {debtType === "commercial" && (<>
                    <div><label style={lbl}>Principal Amount (£)</label><input style={inp} type="number" value={form.principal} onChange={e => upd("principal", e.target.value)} placeholder="0.00" /></div>
                    <div><label style={lbl}>Invoice Date</label><input style={inp} type="date" value={form.invoiceDate} onChange={e => upd("invoiceDate", e.target.value)} /></div>
                    <div><label style={lbl}>Daily Interest (£)</label><input style={inp} type="number" value={form.dailyInterest} onChange={e => upd("dailyInterest", e.target.value)} placeholder="79.00" /></div>
                    <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: 2 }}>
                      {form.principal && form.invoiceDate && (
                        <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.15)", borderRadius: 6, padding: "8px 12px", width: "100%" }}>
                          <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", fontFamily: "var(--mono)" }}>LIVE TOTAL TODAY</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: "#ef4444", fontFamily: "var(--mono)" }}>
                            {fmt((parseFloat(form.principal) || 0) + ((parseFloat(form.dailyInterest) || 79) * Math.max(0, Math.floor((new Date("2026-03-19") - new Date(form.invoiceDate + "T00:00:00")) / 86400000))))}
                          </div>
                          <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)" }}>+{fmt(parseFloat(form.dailyInterest) || 79)}/day</div>
                        </div>
                      )}
                    </div>
                  </>)}

                  {/* CVL: no amount field */}
                  {debtType === "cvl" && (
                    <div style={{ gridColumn: "1 / -1", background: "rgba(168,85,247,0.06)", border: "1px solid rgba(168,85,247,0.12)", borderRadius: 8, padding: "12px 14px" }}>
                      <div style={{ fontSize: 11, color: "#a855f7", fontWeight: 600, marginBottom: 2 }}>Amount determined by AI</div>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", lineHeight: 1.5 }}>Upload intelligence docs in the next step. Claude will read your bank analyses, DCRs, and trace reports to identify all recoverable claims and quantify the total.</div>
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
                  <button onClick={onClose} style={{ padding: "10px 18px", background: "transparent", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 7, color: "rgba(255,255,255,0.4)", cursor: "pointer", fontSize: 12 }}>Cancel</button>
                  <button onClick={() => setStep(2)} style={{ padding: "10px 22px", background: "#3b82f6", border: "none", borderRadius: 7, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Next: Intelligence Docs →</button>
                </div>
              </div>
            )}
          </div>)}

          {/* STEP 2: Intelligence Upload */}
          {step === 2 && (<div>
            <p style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 0, marginBottom: 14, lineHeight: 1.6 }}>
              {debtType === "cvl"
                ? "Upload bank statement analyses, DCRs, LexisNexis traces, correspondence. Claude will identify every applicable claim, quantify the total recoverable, and build the intelligence profile."
                : "Upload the invoice, contract terms, and any correspondence. Claude will verify the debt, calculate accrued interest, and assess recovery strategy."
              }
            </p>

            <div
              onDragOver={e => e.preventDefault()}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              style={{
              border: "2px dashed rgba(255,255,255,0.08)", borderRadius: 10, padding: docs.length > 0 ? "14px" : "36px 14px",
              textAlign: "center", cursor: "pointer", background: "rgba(255,255,255,0.015)", marginBottom: 14
            }}>
              <input ref={fileInputRef} type="file" multiple accept=".pdf,.doc,.docx,.xlsx,.csv,.txt,.zip" onChange={handleFileSelect} style={{ display: "none" }} />
              {docs.length === 0 ? (
                <>
                  <div style={{ fontSize: 26, marginBottom: 6, opacity: 0.4 }}>📁</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.5)", marginBottom: 3 }}>Drop intelligence docs here</div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>
                    {debtType === "cvl" ? "Bank analyses, DCRs, LexisNexis, SoA, correspondence. ZIP files accepted." : "Invoices, contracts, correspondence, credit checks. ZIP files accepted."}
                  </div>
                </>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 5, textAlign: "left" }}>
                  {docs.map((d, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", background: "rgba(255,255,255,0.03)", borderRadius: 6 }}>
                      <span>📄</span>
                      <div style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 600 }}>{d.name}</div><div style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>{d.size}</div></div>
                      <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "rgba(16,185,129,0.12)", color: "#10b981", fontWeight: 600 }}>READY</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {progressMsg && <div style={{ padding: "10px 14px", background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.12)", borderRadius: 6, marginBottom: 10, fontSize: 11, color: "#3b82f6", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ animation: "pulse 1.5s infinite" }}>⏳</span> {progressMsg}
            </div>}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
              <button onClick={() => setStep(1)} style={{ padding: "10px 16px", background: "transparent", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 7, color: "rgba(255,255,255,0.4)", cursor: "pointer", fontSize: 12 }}>← Back</button>
              <button onClick={runAI} disabled={processing} style={{
                padding: "10px 22px", background: processing ? "rgba(59,130,246,0.3)" : "#3b82f6",
                border: "none", borderRadius: 7, color: "#fff", cursor: !processing ? "pointer" : "not-allowed",
                fontSize: 12, fontWeight: 600
              }}>
                {processing ? "🤖 Analysing..." : docs.length > 0 ? "🤖 Analyse with Claude →" : "🤖 Analyse →"}
              </button>
            </div>
            {aiError && <div style={{ fontSize: 12, color: "#ef4444", marginTop: 10, padding: "8px 12px", background: "rgba(239,68,68,0.08)", borderRadius: 6 }}>{aiError}</div>}
          </div>)}

          {/* STEP 3: AI Review */}
          {step === 3 && aiResult && (<div>
            <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
              <Badge label={`Confidence: ${aiResult.confidence}%`} color="#3b82f6" bg="rgba(59,130,246,0.12)" />
              <Badge label={`${PRI_CFG[aiResult.suggestedPriority].label} Priority`} color={PRI_CFG[aiResult.suggestedPriority].color} bg={PRI_CFG[aiResult.suggestedPriority].bg} />
              <Badge label={aiResult.claimStrength} color="rgba(255,255,255,0.5)" bg="rgba(255,255,255,0.05)" />
              <Badge label={debtType === "cvl" ? "CVL" : "Commercial"} color={debtType === "cvl" ? "#a855f7" : "#3b82f6"} bg={debtType === "cvl" ? "rgba(168,85,247,0.12)" : "rgba(59,130,246,0.12)"} />
            </div>

            {/* Amount - different display per type */}
            <div style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.12)", borderRadius: 9, padding: "14px 16px", marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "var(--mono)", marginBottom: 4 }}>
                    {debtType === "cvl" ? "AI-Determined Recoverable" : "Live Running Total"}
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: "#ef4444", fontFamily: "var(--mono)" }}>
                    {fmt(debtType === "cvl" ? aiResult.totalRecoverable : aiResult.currentTotal)}
                  </div>
                </div>
                {debtType === "commercial" && (
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: "var(--mono)" }}>{aiResult.daysOverdue} DAYS OVERDUE</div>
                    <div style={{ fontSize: 13, color: "#ef4444", fontWeight: 600, fontFamily: "var(--mono)", marginTop: 2 }}>+{fmt(aiResult.dailyInterest)}/day</div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", marginTop: 2 }}>+{fmt(aiResult.dailyInterest * 7)}/week</div>
                  </div>
                )}
              </div>
              <div style={{ marginTop: 10 }}>
                {aiResult.breakdown.map((b, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: i < aiResult.breakdown.length - 1 ? "1px solid rgba(255,255,255,0.03)" : "none" }}>
                    <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>{b.desc}</span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: "#ef4444", fontFamily: "var(--mono)" }}>{fmt(b.amt)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Claims identified */}
            <div style={{ background: "rgba(168,85,247,0.06)", border: "1px solid rgba(168,85,247,0.1)", borderRadius: 9, padding: "12px 14px", marginBottom: 12 }}>
              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "var(--mono)", marginBottom: 6 }}>Claims Identified by AI</div>
              {aiResult.claims.map((c, i) => (
                <div key={i} style={{ display: "flex", gap: 6, padding: "4px 0", fontSize: 11, color: "#a855f7", lineHeight: 1.5 }}>⚖️ {c}</div>
              ))}
            </div>

            {/* Assets */}
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: 9, padding: "12px 14px", marginBottom: 12 }}>
              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "var(--mono)", marginBottom: 6 }}>Assets</div>
              {aiResult.assets.map((a, i) => (
                <div key={i} style={{ display: "flex", gap: 6, padding: "3px 0", fontSize: 11, color: "rgba(255,255,255,0.6)", lineHeight: 1.5 }}>
                  <span style={{ color: "#10b981" }}>●</span>{a}
                </div>
              ))}
            </div>

            {/* Flags */}
            <div style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.1)", borderRadius: 9, padding: "12px 14px", marginBottom: 14 }}>
              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "var(--mono)", marginBottom: 6 }}>AI Flags</div>
              {aiResult.flags.map((f, i) => (
                <div key={i} style={{ display: "flex", gap: 6, padding: "3px 0", fontSize: 11, color: "#f59e0b", lineHeight: 1.5 }}>⚠️ {f}</div>
              ))}
            </div>

            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <button onClick={() => setStep(2)} style={{ padding: "10px 16px", background: "transparent", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 7, color: "rgba(255,255,255,0.4)", cursor: "pointer", fontSize: 12 }}>← Back</button>
              <button onClick={async () => {
                setProcessing(true);
                try {
                  // 1. Create debtor in database
                  const result = await onAdd({
                    type: debtType, ...form,
                    baseAmount: debtType === "cvl" && aiResult ? aiResult.totalRecoverable : undefined,
                    principal: debtType === "commercial" && aiResult ? aiResult.principal : parseFloat(form.principal) || 0,
                    dailyInterest: debtType === "commercial" && aiResult ? aiResult.dailyInterest : parseFloat(form.dailyInterest) || 79,
                    invoiceDate: debtType === "commercial" && aiResult ? aiResult.invoiceDate : form.invoiceDate,
                    priority: aiResult ? aiResult.suggestedPriority : "medium",
                    intel: aiResult,
                    realFiles,
                  });
                  onClose();
                } catch (err) {
                  setAiError(err.message || "Failed to save debtor");
                }
                setProcessing(false);
              }} disabled={processing} style={{
                padding: "12px 24px", background: processing ? "rgba(16,185,129,0.3)" : "linear-gradient(135deg, #10b981, #059669)",
                border: "none", borderRadius: 8, color: "#fff", cursor: processing ? "wait" : "pointer", fontSize: 13, fontWeight: 700,
                boxShadow: "0 4px 15px rgba(16,185,129,0.3)"
              }}>{processing ? "Saving..." : "✓ Add Debtor & Start Sequence"}</button>
            </div>
          </div>)}
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════
// DEBTOR PANEL (slide-out)
// ═══════════════════════════════════════════

const DebtorPanel = ({ debtor, onClose, onRefresh }) => {
  const [tab, setTab] = useState("sequence");
  const [stripeLoading, setStripeLoading] = useState(false);
  const [stripeResult, setStripeResult] = useState(null);
  const [actionMsg, setActionMsg] = useState(null);
  if (!debtor) return null;
  const st = STATUS_CFG[debtor.status];
  const seq = SEQUENCES[debtor.priority];
  const totalOwed = calcTotalOwed(debtor);
  const outstanding = calcLiveAmount(debtor);
  const paidPct = totalOwed > 0 ? ((debtor.payments / totalOwed) * 100).toFixed(0) : 0;
  const tabS = (a) => ({ padding: "6px 12px", background: a ? "rgba(255,255,255,0.07)" : "transparent", border: `1px solid ${a ? "rgba(255,255,255,0.1)" : "transparent"}`, borderRadius: 5, color: a ? "#fff" : "rgba(255,255,255,0.3)", cursor: "pointer", fontSize: 10, fontFamily: "var(--body)" });
  const cl = CLIENTS.find(c => c.id === debtor.client);

  return (
    <div style={{ position: "fixed", right: 0, top: 0, bottom: 0, width: 470, background: "#111120", borderLeft: "1px solid rgba(255,255,255,0.06)", zIndex: 900, overflowY: "auto", boxShadow: "-20px 0 60px rgba(0,0,0,0.6)" }}>
      <div style={{ padding: "18px 18px 0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15 }}>{debtor.name}</h3>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 1 }}>{debtor.company}</div>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", fontFamily: "var(--mono)", marginTop: 1 }}>CO. {debtor.coNumber}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.3)", fontSize: 16, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
          <Badge label={st.label} color={st.color} bg={st.bg} />
          <Badge label={`${PRI_CFG[debtor.priority].label}`} color={PRI_CFG[debtor.priority].color} bg="rgba(255,255,255,0.05)" />
          <Badge label={debtor.type === "cvl" ? "CVL" : "Commercial"} color={debtor.type === "cvl" ? "#a855f7" : "#3b82f6"} bg={debtor.type === "cvl" ? "rgba(168,85,247,0.1)" : "rgba(59,130,246,0.1)"} />
          <Badge label={`Day ${debtor.seqDay}`} color="rgba(255,255,255,0.4)" bg="rgba(255,255,255,0.04)" />
          {CURRENT_USER.role === "admin" && cl && <Badge label={cl.name} color={cl.color} bg={cl.color + "18"} />}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
          <div style={{ background: "rgba(239,68,68,0.06)", borderRadius: 7, padding: 10 }}>
            <div style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "var(--mono)" }}>
              {debtor.type === "commercial" ? "Live Total" : "Owed"}
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, color: "#ef4444", fontFamily: "var(--mono)", marginTop: 2 }}>{fmt(totalOwed)}</div>
            {debtor.type === "commercial" && (
              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", marginTop: 2 }}>+{fmt(debtor.dailyInterest)}/day</div>
            )}
          </div>
          <div style={{ background: "rgba(16,185,129,0.06)", borderRadius: 7, padding: 10 }}>
            <div style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "var(--mono)" }}>Recovered</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: "#10b981", fontFamily: "var(--mono)", marginTop: 2 }}>{fmt(debtor.payments)}</div>
          </div>
        </div>

        {totalOwed > 0 && <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.25)" }}>Recovery</span>
            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", fontFamily: "var(--mono)" }}>{paidPct}%</span>
          </div>
          <Bar value={debtor.payments} max={totalOwed} color="#10b981" />
        </div>}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5, marginBottom: 6 }}>
          <button onClick={async () => {
            setActionMsg(null); setStripeResult(null);
            try {
              const res = await sendEmail(debtor.id, "initial_demand");
              if (res.error) setActionMsg(res.error);
              else { setActionMsg("Email sent to " + debtor.email); if (onRefresh) onRefresh(); }
            } catch (e) { setActionMsg(e.message); }
          }} style={{ padding: "7px 0", background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.15)", borderRadius: 5, color: "#3b82f6", cursor: "pointer", fontSize: 10, fontWeight: 600 }}>Email</button>
          <button onClick={async () => {
            setActionMsg(null); setStripeResult(null);
            try {
              const res = await makeCall(debtor.id, "professional");
              if (res.error) setActionMsg(res.error);
              else { setActionMsg("AI call initiated to " + debtor.phone); if (onRefresh) onRefresh(); }
            } catch (e) { setActionMsg(e.message); }
          }} style={{ padding: "7px 0", background: "rgba(168,85,247,0.08)", border: "1px solid rgba(168,85,247,0.15)", borderRadius: 5, color: "#a855f7", cursor: "pointer", fontSize: 10, fontWeight: 600 }}>AI Call</button>
          <button onClick={async () => {
            setStripeLoading(true); setStripeResult(null); setActionMsg(null);
            try {
              const res = await generatePaymentLink(debtor.id);
              if (res.error) { setActionMsg(res.error); }
              else { setStripeResult(res.payment_link); if (onRefresh) onRefresh(); }
            } catch (e) { setActionMsg(e.message); }
            setStripeLoading(false);
          }} disabled={stripeLoading} style={{ padding: "7px 0", background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.15)", borderRadius: 5, color: "#10b981", cursor: stripeLoading ? "wait" : "pointer", fontSize: 10, fontWeight: 600 }}>
            {stripeLoading ? "Generating..." : "Stripe Link"}
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginBottom: 6 }}>
          <button onClick={async () => {
            setActionMsg(null);
            try {
              const res = await sendSMS(debtor.id, "sms", "initial_chase");
              if (res.error) setActionMsg(res.error);
              else { setActionMsg("SMS sent to " + debtor.phone); if (onRefresh) onRefresh(); }
            } catch (e) { setActionMsg(e.message); }
          }} style={{ padding: "7px 0", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.15)", borderRadius: 5, color: "#f59e0b", cursor: "pointer", fontSize: 10, fontWeight: 600 }}>SMS</button>
          <button onClick={async () => {
            setActionMsg(null);
            try {
              const res = await sendSMS(debtor.id, "whatsapp", "initial_chase");
              if (res.error) setActionMsg(res.error);
              else { setActionMsg("WhatsApp sent to " + debtor.phone); if (onRefresh) onRefresh(); }
            } catch (e) { setActionMsg(e.message); }
          }} style={{ padding: "7px 0", background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.15)", borderRadius: 5, color: "#22c55e", cursor: "pointer", fontSize: 10, fontWeight: 600 }}>WhatsApp</button>
        </div>
        {stripeResult && (
          <div style={{ padding: "8px 10px", background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.12)", borderRadius: 6, marginBottom: 8 }}>
            <div style={{ fontSize: 9, color: "#10b981", fontWeight: 600, marginBottom: 3 }}>PAYMENT LINK GENERATED</div>
            <a href={stripeResult} target="_blank" rel="noopener" style={{ fontSize: 10, color: "#3b82f6", wordBreak: "break-all" }}>{stripeResult}</a>
          </div>
        )}
        {actionMsg && (
          <div style={{ padding: "8px 10px", background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.12)", borderRadius: 6, marginBottom: 8, fontSize: 10, color: "#f59e0b" }}>{actionMsg}</div>
        )}

        <div style={{ display: "flex", gap: 3, marginBottom: 12 }}>
          {["sequence", "intelligence", "contact", "actions"].map(t => (
            <button key={t} onClick={() => setTab(t)} style={tabS(tab === t)}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: "0 18px 18px" }}>
        {tab === "sequence" && (
          <div>
            {/* Real activity */}
            {(debtor.timeline || []).length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "var(--mono)", marginBottom: 8 }}>Activity</div>
                {(debtor.timeline || []).sort((a, b) => (b.ts || "").localeCompare(a.ts || "")).map((t, i) => {
                  const ch = CHANNELS[t.channel] || { icon: "📋", color: "#6b7280", label: t.channel };
                  return (
                    <div key={i} style={{ display: "flex", gap: 12, marginBottom: 2 }}>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 26, flexShrink: 0 }}>
                        <div style={{ width: 9, height: 9, borderRadius: 5, background: ch.color, border: `2px solid ${ch.color}`, zIndex: 1, boxShadow: `0 0 6px ${ch.color}44` }} />
                        {i < (debtor.timeline || []).length - 1 && <div style={{ width: 1.5, flex: 1, background: "rgba(255,255,255,0.06)", minHeight: 20 }} />}
                      </div>
                      <div style={{ flex: 1, paddingBottom: 10 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
                          <span style={{ fontSize: 10 }}>{ch.icon}</span>
                          <span style={{ fontSize: 10, fontWeight: 600, color: "#fff" }}>{ch.label || t.channel}</span>
                          <span style={{ fontSize: 9, color: ch.color, fontWeight: 600 }}>{t.direction === "in" ? "↙ " : "↗ "}{(t.result || "").replace(/_/g, " ")}</span>
                        </div>
                        {t.ts && <div style={{ fontSize: 8, color: "rgba(255,255,255,0.2)", fontFamily: "var(--mono)", marginBottom: 2 }}>{new Date(t.ts).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</div>}
                        {(t.summary || t.transcript) && <div style={{ padding: "5px 7px", background: "rgba(255,255,255,0.02)", borderRadius: 4, borderLeft: `2px solid ${ch.color}`, fontSize: 10, color: "rgba(255,255,255,0.45)", lineHeight: 1.5, fontStyle: t.transcript ? "italic" : "normal", maxHeight: 150, overflowY: "auto" }}>{t.transcript || t.summary}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {(debtor.timeline || []).length === 0 && (
              <div style={{ padding: 16, textAlign: "center", color: "rgba(255,255,255,0.15)", fontSize: 11, marginBottom: 16 }}>No activity yet</div>
            )}

            {/* Upcoming steps */}
            {seq && (() => {
              const firedChannels = new Set((debtor.timeline || []).map(t => t.day + "_" + t.channel));
              const upcoming = seq.steps.filter(s => !firedChannels.has(s.day + "_" + s.channel));
              if (upcoming.length === 0) return null;
              return (
                <div>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "var(--mono)", marginBottom: 8, borderTop: "1px solid rgba(255,255,255,0.04)", paddingTop: 12 }}>Coming Up</div>
                  {upcoming.map((s, i) => {
                    const ch = CHANNELS[s.channel];
                    return (
                      <div key={i} style={{ display: "flex", gap: 12, marginBottom: 2 }}>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 26, flexShrink: 0 }}>
                          <div style={{ width: 9, height: 9, borderRadius: 5, background: "rgba(255,255,255,0.06)", border: "2px solid rgba(255,255,255,0.04)" }} />
                          {i < upcoming.length - 1 && <div style={{ width: 1.5, flex: 1, background: "rgba(255,255,255,0.03)", minHeight: 20 }} />}
                        </div>
                        <div style={{ flex: 1, paddingBottom: 10 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                            <span style={{ fontSize: 9, fontFamily: "var(--mono)", color: "rgba(255,255,255,0.15)", minWidth: 30 }}>D{s.day}</span>
                            <span style={{ fontSize: 10, opacity: 0.4 }}>{ch.icon}</span>
                            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)" }}>{s.action}</span>
                            <span style={{ fontSize: 7, padding: "1px 4px", borderRadius: 2, background: s.auto ? "rgba(59,130,246,0.06)" : "rgba(245,158,11,0.06)", color: s.auto ? "rgba(59,130,246,0.5)" : "rgba(245,158,11,0.5)", fontWeight: 700 }}>{s.auto ? "AUTO" : "MANUAL"}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        )}

        {tab === "intelligence" && debtor.intel && (
          <div>
            <div style={{ display: "flex", gap: 5, marginBottom: 12 }}>
              <Badge label={`${debtor.intel.confidence}% confidence`} color="#3b82f6" bg="rgba(59,130,246,0.1)" />
              <Badge label={debtor.intel.claimStrength} color="rgba(255,255,255,0.5)" bg="rgba(255,255,255,0.04)" />
            </div>

            {/* Claims */}
            <div style={{ background: "rgba(168,85,247,0.05)", border: "1px solid rgba(168,85,247,0.1)", borderRadius: 8, padding: "10px 12px", marginBottom: 10 }}>
              <div style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "var(--mono)", marginBottom: 5 }}>Claims Identified</div>
              {debtor.intel.claims.map((c, i) => (
                <div key={i} style={{ fontSize: 10, color: "#a855f7", padding: "3px 0", lineHeight: 1.5 }}>⚖️ {c}</div>
              ))}
            </div>

            {/* Breakdown */}
            <div style={{ background: "rgba(239,68,68,0.04)", border: "1px solid rgba(239,68,68,0.08)", borderRadius: 8, padding: "10px 12px", marginBottom: 10 }}>
              <div style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "var(--mono)", marginBottom: 5 }}>Breakdown</div>
              {debtor.intel.breakdown.map((b, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.5)" }}>{b.desc}</span>
                  <span style={{ fontSize: 10, fontWeight: 600, color: "#ef4444", fontFamily: "var(--mono)" }}>{fmt(b.amt)}</span>
                </div>
              ))}
            </div>

            {/* Assets */}
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: 8, padding: "10px 12px", marginBottom: 10 }}>
              <div style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "var(--mono)", marginBottom: 5 }}>Assets</div>
              {debtor.intel.assets.map((a, i) => (
                <div key={i} style={{ fontSize: 10, color: "rgba(255,255,255,0.55)", padding: "2px 0", lineHeight: 1.5 }}><span style={{ color: "#10b981" }}>●</span> {a}</div>
              ))}
            </div>

            {/* Flags */}
            {debtor.intel.flags && debtor.intel.flags.length > 0 && (
              <div style={{ background: "rgba(245,158,11,0.04)", border: "1px solid rgba(245,158,11,0.08)", borderRadius: 8, padding: "10px 12px", marginBottom: 10 }}>
                <div style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "var(--mono)", marginBottom: 5 }}>Flags</div>
                {debtor.intel.flags.map((f, i) => (
                  <div key={i} style={{ fontSize: 10, color: "#f59e0b", padding: "2px 0", lineHeight: 1.5 }}>⚠️ {f}</div>
                ))}
              </div>
            )}

            {/* Docs */}
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: 8, padding: "10px 12px", marginBottom: 10 }}>
              <div style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "var(--mono)", marginBottom: 5 }}>Source Documents</div>
              {debtor.intel.docs.map((d, i) => (
                <div key={i} style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", padding: "2px 0" }}>📎 {d}</div>
              ))}
            </div>

            <button style={{ width: "100%", padding: "9px", background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.15)", borderRadius: 6, color: "#3b82f6", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>+ Add More Intelligence</button>
          </div>
        )}

        {tab === "contact" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              { i: "✉", l: "Email", v: debtor.email },
              { i: "📞", l: "Phone", v: debtor.phone },
              { i: "📍", l: "Address", v: debtor.address },
              { i: "🏢", l: "Company No.", v: debtor.coNumber },
            ].map((f, i) => (
              <div key={i} style={{ display: "flex", gap: 8, padding: "8px 10px", background: "rgba(255,255,255,0.02)", borderRadius: 6 }}>
                <span style={{ fontSize: 12 }}>{f.i}</span>
                <div><div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", textTransform: "uppercase" }}>{f.l}</div><div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginTop: 1 }}>{f.v}</div></div>
              </div>
            ))}
          </div>
        )}

        {tab === "actions" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {/* Payment Plan Creator */}
            <div style={{ background: "rgba(16,185,129,0.04)", border: "1px solid rgba(16,185,129,0.1)", borderRadius: 8, padding: 12, marginBottom: 4 }}>
              <div style={{ fontSize: 10, color: "#10b981", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>Payment Plan</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", marginBottom: 3 }}>£/month</div>
                  <input id="pp-amount" type="number" placeholder="200" style={{ width: "100%", padding: "7px 8px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 5, color: "#fff", fontSize: 12, outline: "none", boxSizing: "border-box" }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", marginBottom: 3 }}>Months</div>
                  <input id="pp-months" type="number" placeholder="12" style={{ width: "100%", padding: "7px 8px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 5, color: "#fff", fontSize: 12, outline: "none", boxSizing: "border-box" }} />
                </div>
              </div>
              <button onClick={async () => {
                const amt = parseFloat(document.getElementById("pp-amount")?.value);
                const months = parseInt(document.getElementById("pp-months")?.value);
                if (!amt && !months) { setActionMsg("Enter monthly amount or number of months"); return; }
                setActionMsg(null);
                try {
                  const res = await createPaymentPlan(debtor.id, amt || undefined, months || undefined);
                  if (res.error) setActionMsg(res.error);
                  else {
                    setStripeResult(res.payment_link);
                    setActionMsg(`Plan created: ${res.total_months}x £${res.monthly_amount.toFixed(2)}/month. Link generated.`);
                    if (onRefresh) onRefresh();
                  }
                } catch (e) { setActionMsg(e.message); }
              }} style={{ width: "100%", padding: "8px", background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.25)", borderRadius: 6, color: "#10b981", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Generate Plan & Stripe Link</button>
            </div>

            {/* Quick send plan via channels */}
            {debtor.stripeLink && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, marginBottom: 4 }}>
                <button onClick={async () => {
                  try { await sendEmail(debtor.id, "payment_plan_confirmation"); setActionMsg("Plan confirmation emailed"); if (onRefresh) onRefresh(); } catch(e) { setActionMsg(e.message); }
                }} style={{ padding: "7px", background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.15)", borderRadius: 5, color: "#3b82f6", cursor: "pointer", fontSize: 9, fontWeight: 600 }}>Email Link</button>
                <button onClick={async () => {
                  try { await sendSMS(debtor.id, "sms", null, `Your payment plan link as agreed: ${debtor.stripeLink} - Zenith Legal`); setActionMsg("SMS sent"); if (onRefresh) onRefresh(); } catch(e) { setActionMsg(e.message); }
                }} style={{ padding: "7px", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.15)", borderRadius: 5, color: "#f59e0b", cursor: "pointer", fontSize: 9, fontWeight: 600 }}>SMS Link</button>
                <button onClick={async () => {
                  try { await sendSMS(debtor.id, "whatsapp", null, `Your payment plan link as agreed: ${debtor.stripeLink} - Zenith Legal`); setActionMsg("WhatsApp sent"); if (onRefresh) onRefresh(); } catch(e) { setActionMsg(e.message); }
                }} style={{ padding: "7px", background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.15)", borderRadius: 5, color: "#22c55e", cursor: "pointer", fontSize: 9, fontWeight: 600 }}>WhatsApp Link</button>
              </div>
            )}

            {/* Other actions */}
            <button onClick={async () => {
              const { createBrowserClient } = await import("@/lib/supabase");
              const sb = createBrowserClient();
              await sb.from("debtors").update({ sequence_paused: true, next_action: "Sequence paused manually" }).eq("id", debtor.id);
              setActionMsg("Sequence paused"); if (onRefresh) onRefresh();
            }} style={{ padding: "9px 11px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: 6, cursor: "pointer", textAlign: "left" }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#f59e0b" }}>Pause Sequence</span>
            </button>
            <button onClick={async () => {
              const { createBrowserClient } = await import("@/lib/supabase");
              const sb = createBrowserClient();
              await sb.from("debtors").update({ sequence_paused: false }).eq("id", debtor.id);
              setActionMsg("Sequence resumed"); if (onRefresh) onRefresh();
            }} style={{ padding: "9px 11px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: 6, cursor: "pointer", textAlign: "left" }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#3b82f6" }}>Resume Sequence</span>
            </button>
            <button onClick={async () => {
              const { createBrowserClient } = await import("@/lib/supabase");
              const sb = createBrowserClient();
              await sb.from("debtors").update({ status: "disputed", sequence_paused: true, next_action: "DISPUTED - human review" }).eq("id", debtor.id);
              setActionMsg("Marked as disputed, sequence paused"); if (onRefresh) onRefresh();
            }} style={{ padding: "9px 11px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: 6, cursor: "pointer", textAlign: "left" }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#ef4444" }}>Mark Disputed</span>
            </button>
            <button onClick={async () => {
              const { createBrowserClient } = await import("@/lib/supabase");
              const sb = createBrowserClient();
              await sb.from("debtors").update({ status: "escalated", sequence_paused: true, next_action: "Escalated to legal" }).eq("id", debtor.id);
              setActionMsg("Escalated to legal"); if (onRefresh) onRefresh();
            }} style={{ padding: "9px 11px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: 6, cursor: "pointer", textAlign: "left" }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#ef4444" }}>Escalate to Legal</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════

export default function Ashveil() {
  const { user } = useUser();
  const { clients, addClient, updateClient, deleteClient } = useClients();
  const { users, inviteUser } = useUsers();
  const { debtors: rawDebtors, refresh: refreshDebtors, addDebtor: addDebtorToDb } = useDebtors();
  const health = useHealth();

  // Set globals for sub-components
  CLIENTS = clients;
  CURRENT_USER = user || { name: "Loading...", role: "admin", email: "" };

  const debtors = useMemo(() => rawDebtors.map(normalizeDebtor), [rawDebtors]);

  const [view, setView] = useState("dashboard");
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [seqView, setSeqView] = useState("high");
  const [collapsed, setCollapsed] = useState(false);
  const [clientFilter, setClientFilter] = useState("all");
  const [showClientModal, setShowClientModal] = useState(null); // null or client object or {}
  const [showUserModal, setShowUserModal] = useState(false);

  // Auto-refresh selected debtor when data updates
  useEffect(() => {
    if (selected && debtors.length > 0) {
      const updated = debtors.find(d => d.id === selected.id);
      if (updated) setSelected(updated);
    }
  }, [debtors]);

  // Auto-refresh data every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => { refreshDebtors(); }, 30000);
    return () => clearInterval(interval);
  }, [refreshDebtors]);

  // Compute real channel stats from all timelines
  const channelStats = useMemo(() => {
    const stats = { email: { sent: 0, engaged: 0 }, call: { sent: 0, engaged: 0 }, sms: { sent: 0, engaged: 0 }, whatsapp: { sent: 0, engaged: 0 }, payment: { sent: 0, engaged: 0 } };
    debtors.forEach(d => {
      (d.timeline || []).forEach(t => {
        if (t.status === "sent" && stats[t.channel]) {
          stats[t.channel].sent++;
          if (["opened", "replied", "answered", "partial_paid", "paid_full", "link_generated"].includes(t.result)) {
            stats[t.channel].engaged++;
          }
        }
      });
    });
    return stats;
  }, [debtors]);

  // Recent activity from all debtors
  const recentActivity = useMemo(() => {
    return debtors.flatMap(d =>
      (d.timeline || []).filter(t => t.ts).map(t => ({ ...t, debtor: d }))
    ).sort((a, b) => (b.ts || "").localeCompare(a.ts || "")).slice(0, 15);
  }, [debtors]);

  const totalOwed = useMemo(() => debtors.reduce((s, d) => s + calcTotalOwed(d), 0), [debtors]);
  const totalRecovered = debtors.reduce((s, d) => s + d.payments, 0);
  const filtered = debtors.filter(d => {
    if (filter !== "all" && d.status !== filter) return false;
    if (clientFilter !== "all" && d.client !== clientFilter) return false;
    if (search && !d.name.toLowerCase().includes(search.toLowerCase()) && !d.company.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const handleAdd = async (data) => {
    const { data: debtor, error } = await addDebtorToDb({
      client_id: data.client || clients[0]?.id,
      type: data.type,
      name: data.name,
      company: data.company,
      co_number: data.coNumber,
      email: data.email,
      phone: data.phone,
      address: data.address,
      base_amount: data.baseAmount || 0,
      principal: data.principal || 0,
      daily_interest: data.dailyInterest || 79,
      invoice_date: data.invoiceDate || null,
      priority: data.priority || "medium",
    });

    if (error || !debtor) throw new Error(error?.message || "Failed to create debtor");

    // Upload files to Supabase storage
    if (data.realFiles && data.realFiles.length > 0) {
      await uploadDocuments(debtor.id, data.realFiles);
    }

    // Save intelligence analysis
    if (data.intel) {
      const { createBrowserClient } = await import("@/lib/supabase");
      const supabase = createBrowserClient();
      await supabase.from("intelligence").insert({
        debtor_id: debtor.id,
        confidence: data.intel.confidence,
        claim_strength: data.intel.claimStrength,
        total_recoverable: data.intel.totalRecoverable || null,
        claims: data.intel.claims,
        assets: data.intel.assets,
        flags: data.intel.flags,
        breakdown: data.intel.breakdown,
      });

      // Update debtor with AI-determined amount
      if (data.type === "cvl" && data.intel.totalRecoverable) {
        await supabase.from("debtors").update({ base_amount: data.intel.totalRecoverable }).eq("id", debtor.id);
      }
    }

    // Generate Stripe payment link
    try {
      await generatePaymentLink(debtor.id);
    } catch (e) {
      console.log("Stripe link generation deferred:", e.message);
    }

    await refreshDebtors();
    return debtor;
  };

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> },
    { id: "debtors", label: "Debtors", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg> },
    { id: "sequences", label: "Sequences", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> },
    { id: "settings", label: "Settings", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33"/></svg> },
  ];

  return (
    <div style={{ "--mono": "'JetBrains Mono', monospace", "--body": "'DM Sans', sans-serif", display: "flex", height: "100vh", background: "#0c0c18", color: "#fff", fontFamily: "var(--body)", overflow: "hidden" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`@keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}`}</style>

      {/* Sidebar */}
      <div style={{ width: collapsed ? 52 : 185, background: "#090914", borderRight: "1px solid rgba(255,255,255,0.04)", display: "flex", flexDirection: "column", transition: "width 0.2s", flexShrink: 0 }}>
        <div style={{ padding: collapsed ? "15px 9px" : "15px 13px", borderBottom: "1px solid rgba(255,255,255,0.04)", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} onClick={() => setCollapsed(!collapsed)}>
          <div style={{ width: 27, height: 27, borderRadius: 6, background: "linear-gradient(135deg, #3b82f6, #1e40af)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0, fontFamily: "var(--mono)", boxShadow: "0 0 10px rgba(59,130,246,0.3)" }}>A</div>
          {!collapsed && <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: 1.5, fontFamily: "var(--mono)" }}>ASHVEIL</span>}
        </div>
        <div style={{ padding: "8px 5px", flex: 1 }}>
          {navItems.map(n => (
            <button key={n.id} onClick={() => setView(n.id)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: collapsed ? "8px 12px" : "8px 10px", background: view === n.id ? "rgba(59,130,246,0.1)" : "transparent", border: "none", borderRadius: 6, color: view === n.id ? "#3b82f6" : "rgba(255,255,255,0.3)", cursor: "pointer", fontSize: 12, fontFamily: "var(--body)", marginBottom: 1, whiteSpace: "nowrap", textAlign: "left" }}>
              <span style={{ flexShrink: 0 }}>{n.icon}</span>{!collapsed && n.label}
            </button>
          ))}
        </div>
        {!collapsed && (
          <div style={{ padding: "10px 13px", borderTop: "1px solid rgba(255,255,255,0.04)", fontSize: 8 }}>
            {[["Stripe",health.stripe],["Vapi",health.vapi],["Twilio",health.twilio],["SendGrid",health.sendgrid],["Claude",health.anthropic]].map(([n,ok]) => (
              <div key={n} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
                <div style={{ width: 4, height: 4, borderRadius: 2, background: ok ? "#10b981" : "#ef4444" }} />
                <span style={{ color: "rgba(255,255,255,0.2)" }}>{n}</span>
              </div>
            ))}
          </div>
        )}
        {!collapsed && (
          <div style={{ padding: "10px 13px", borderTop: "1px solid rgba(255,255,255,0.04)", display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 24, height: 24, borderRadius: 12, background: "rgba(59,130,246,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "#3b82f6", fontFamily: "var(--mono)", flexShrink: 0 }}>JA</div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,0.5)" }}>{CURRENT_USER.name}</div>
              <div style={{ fontSize: 8, color: "rgba(255,255,255,0.2)", textTransform: "uppercase" }}>{CURRENT_USER.role}</div>
            </div>
          </div>
        )}
        {!collapsed && (
          <div style={{ padding: "0 13px 10px" }}>
            <button onClick={signOut} style={{ width: "100%", padding: "6px", background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.1)", borderRadius: 5, color: "#ef4444", cursor: "pointer", fontSize: 9 }}>Sign Out</button>
          </div>
        )}
      </div>

      {/* Main */}
      <div style={{ flex: 1, overflow: "auto", padding: 22, paddingRight: selected ? 494 : 22 }}>

        {/* DASHBOARD */}
        {view === "dashboard" && (<div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, marginBottom: 2 }}>Dashboard</h1>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginBottom: 18 }}>Zenith ODLA & Commercial Recovery</div>
          <div style={{ display: "flex", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
            <Stat label="Total Book (Live)" value={fmt(totalOwed)} sub="Includes accrued interest" />
            <Stat label="Recovered" value={fmt(totalRecovered)} sub={`${((totalRecovered/totalOwed)*100).toFixed(1)}% rate`} accent="#10b981" />
            <Stat label="CVL Cases" value={debtors.filter(d => d.type === "cvl").length} accent="#a855f7" />
            <Stat label="Commercial" value={debtors.filter(d => d.type === "commercial").length} accent="#3b82f6" />
          </div>
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "var(--mono)" }}>Recovery Rate</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#10b981", fontFamily: "var(--mono)" }}>{((totalRecovered/totalOwed)*100).toFixed(1)}%</span>
            </div>
            <Bar value={totalRecovered} max={totalOwed} color="#10b981" h={8} />
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
            {Object.entries(STATUS_CFG).map(([key, cfg]) => {
              const count = debtors.filter(d => d.status === key).length;
              if (count === 0) return null;
              const total = debtors.filter(d => d.status === key).reduce((s, d) => s + calcTotalOwed(d), 0);
              return (
                <div key={key} onClick={() => { setView("debtors"); setFilter(key); }} style={{ background: cfg.bg, border: `1px solid ${cfg.color}15`, borderRadius: 8, padding: "12px 15px", cursor: "pointer", flex: 1, minWidth: 100 }}>
                  <div style={{ fontSize: 9, color: cfg.color, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>{cfg.label}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--mono)" }}>{count}</div>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", fontFamily: "var(--mono)", marginTop: 2 }}>{fmt(total)}</div>
                </div>
              );
            })}
          </div>

          {/* Channel Performance - real data */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 18 }}>
            {Object.entries(channelStats).map(([ch, s]) => {
              const cfg = CHANNELS[ch];
              if (!cfg) return null;
              const rate = s.sent > 0 ? Math.round((s.engaged / s.sent) * 100) + "%" : "0%";
              return (
                <div key={ch} style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: 8, padding: "10px 9px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 6 }}>
                    <span style={{ fontSize: 11 }}>{cfg.icon}</span>
                    <span style={{ fontSize: 9, fontWeight: 600, color: cfg.color }}>{cfg.label}</span>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--mono)", marginBottom: 2 }}>{rate}</div>
                  <div style={{ fontSize: 8, color: "rgba(255,255,255,0.2)" }}>{s.sent} sent / {s.engaged} engaged</div>
                  <div style={{ marginTop: 5 }}><Bar value={s.engaged} max={Math.max(s.sent, 1)} color={cfg.color} h={3} /></div>
                </div>
              );
            })}
          </div>

          {/* Recent Activity - real data */}
          {recentActivity.length > 0 && (<>
            <h2 style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.5)", marginBottom: 10 }}>Recent Activity</h2>
            <div style={{ background: "rgba(255,255,255,0.015)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: 8, marginBottom: 18 }}>
              {recentActivity.map((item, i) => {
                const cfg = CHANNELS[item.channel] || { icon: "📋", color: "#6b7280" };
                return (
                  <div key={i} onClick={() => { setSelected(item.debtor); setView("debtors"); }}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: i < recentActivity.length - 1 ? "1px solid rgba(255,255,255,0.03)" : "none", cursor: "pointer" }}
                    onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.02)"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                  >
                    <span style={{ fontSize: 12 }}>{cfg.icon}</span>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 11, fontWeight: 600 }}>{item.debtor?.company || "Unknown"}</span>
                      <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginLeft: 6 }}>{item.result?.replace(/_/g, " ") || item.channel}</span>
                    </div>
                    <div style={{ fontSize: 8, color: "rgba(255,255,255,0.15)", fontFamily: "var(--mono)" }}>{item.ts ? new Date(item.ts).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}</div>
                  </div>
                );
              })}
            </div>
          </>)}
        </div>)}

        {/* DEBTORS */}
        {view === "debtors" && (<div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div><h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Debtors</h1><div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 2 }}>{filtered.length} cases</div></div>
            <button onClick={() => setShowAdd(true)} style={{ padding: "9px 16px", background: "#3b82f6", border: "none", borderRadius: 7, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>+ Add Debtor</button>
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
            <input placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} style={{ flex: 1, minWidth: 150, padding: "8px 11px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6, color: "#fff", fontSize: 11, outline: "none" }} />
            {CURRENT_USER.role === "admin" && (
              <select value={clientFilter} onChange={e => setClientFilter(e.target.value)} style={{ padding: "6px 10px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 5, color: clientFilter === "all" ? "rgba(255,255,255,0.3)" : "#fff", fontSize: 10, outline: "none", appearance: "none", cursor: "pointer", minWidth: 120 }}>
                <option value="all">All Clients</option>
                {CLIENTS.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <div style={{ display: "flex", gap: 2 }}>
              {[{ k: "all", l: "All" }, ...Object.entries(STATUS_CFG).map(([k, v]) => ({ k, l: v.label }))].map(f => (
                <button key={f.k} onClick={() => setFilter(f.k)} style={{ padding: "5px 9px", background: filter === f.k ? "rgba(59,130,246,0.1)" : "rgba(255,255,255,0.02)", border: `1px solid ${filter === f.k ? "rgba(59,130,246,0.18)" : "rgba(255,255,255,0.04)"}`, borderRadius: 4, color: filter === f.k ? "#3b82f6" : "rgba(255,255,255,0.25)", cursor: "pointer", fontSize: 9, whiteSpace: "nowrap" }}>{f.l}</button>
              ))}
            </div>
          </div>
          <div style={{ background: "rgba(255,255,255,0.015)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: CURRENT_USER.role === "admin" ? "1.6fr 0.7fr 0.5fr 1fr 0.7fr 0.4fr 1.1fr" : "1.8fr 0.5fr 1fr 0.7fr 0.5fr 1.2fr", padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 8, color: "rgba(255,255,255,0.2)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "var(--mono)" }}>
              <div>Company</div>{CURRENT_USER.role === "admin" && <div>Client</div>}<div>Type</div><div>Amount</div><div>Status</div><div>Day</div><div>Next Action</div>
            </div>
            {filtered.map(d => {
              const st = STATUS_CFG[d.status]; const owedNow = calcTotalOwed(d); const isSel = selected?.id === d.id;
              const cl = CLIENTS.find(c => c.id === d.client);
              return (
                <div key={d.id} onClick={() => setSelected(d)} style={{ display: "grid", gridTemplateColumns: CURRENT_USER.role === "admin" ? "1.6fr 0.7fr 0.5fr 1fr 0.7fr 0.4fr 1.1fr" : "1.8fr 0.5fr 1fr 0.7fr 0.5fr 1.2fr", padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.02)", cursor: "pointer", background: isSel ? "rgba(59,130,246,0.04)" : "transparent" }}
                  onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = "rgba(255,255,255,0.01)"; }}
                  onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = "transparent"; }}
                >
                  <div><div style={{ fontSize: 11, fontWeight: 600 }}>{d.company}</div><div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", marginTop: 1 }}>{d.name}</div></div>
                  {CURRENT_USER.role === "admin" && <div>{cl && <Badge label={cl.name} color={cl.color} bg={cl.color + "18"} />}</div>}
                  <div><Badge label={d.type === "cvl" ? "CVL" : "COM"} color={d.type === "cvl" ? "#a855f7" : "#3b82f6"} bg={d.type === "cvl" ? "rgba(168,85,247,0.1)" : "rgba(59,130,246,0.1)"} /></div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, fontFamily: "var(--mono)" }}>{fmt(owedNow)}</div>
                    {d.payments > 0 && <div style={{ fontSize: 9, color: "#10b981", fontFamily: "var(--mono)" }}>-{fmt(d.payments)}</div>}
                    {d.type === "commercial" && <div style={{ fontSize: 8, color: "rgba(255,255,255,0.15)", fontFamily: "var(--mono)" }}>+{fmt(d.dailyInterest)}/d</div>}
                  </div>
                  <div><Badge label={st.label} color={st.color} bg={st.bg} /></div>
                  <div style={{ fontSize: 11, fontFamily: "var(--mono)", color: "rgba(255,255,255,0.3)" }}>{d.seqDay}</div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>{d.nextAction}</div>
                </div>
              );
            })}
          </div>
        </div>)}

        {/* SEQUENCES */}
        {view === "sequences" && (<div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, marginBottom: 2 }}>Escalation Sequences</h1>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginBottom: 18 }}>Multi-channel automated chase by priority</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
            {Object.entries(SEQUENCES).map(([key, seq]) => (
              <button key={key} onClick={() => setSeqView(key)} style={{ flex: 1, padding: "11px 13px", background: seqView === key ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.01)", border: `1px solid ${seqView === key ? PRI_CFG[key].color + "30" : "rgba(255,255,255,0.04)"}`, borderRadius: 8, cursor: "pointer", textAlign: "left" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: PRI_CFG[key].color }}>{seq.name}</div>
                <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", fontFamily: "var(--mono)", marginTop: 2 }}>{seq.steps.length} steps / {seq.steps[seq.steps.length-1].day}d</div>
              </button>
            ))}
          </div>
          <div style={{ background: "rgba(255,255,255,0.015)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: 8, padding: 18 }}>
            {SEQUENCES[seqView].steps.map((s, i) => {
              const ch = CHANNELS[s.channel];
              return (
                <div key={i} style={{ display: "flex", gap: 12 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 28 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 5, background: ch.color, zIndex: 1, boxShadow: `0 0 6px ${ch.color}30` }} />
                    {i < SEQUENCES[seqView].steps.length - 1 && <div style={{ width: 1.5, flex: 1, background: "rgba(255,255,255,0.04)", minHeight: 38 }} />}
                  </div>
                  <div style={{ flex: 1, paddingBottom: 18 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 10, fontFamily: "var(--mono)", color: "rgba(255,255,255,0.3)", fontWeight: 600, minWidth: 40 }}>Day {s.day}</span>
                      <span style={{ fontSize: 12 }}>{ch.icon}</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "#fff" }}>{s.action}</span>
                      <span style={{ fontSize: 8, padding: "2px 5px", borderRadius: 3, background: s.auto ? "rgba(59,130,246,0.1)" : "rgba(245,158,11,0.1)", color: s.auto ? "#3b82f6" : "#f59e0b", fontWeight: 700 }}>{s.auto ? "AUTO" : "MANUAL"}</span>
                    </div>
                    <div style={{ marginLeft: 46, fontSize: 9, color: "rgba(255,255,255,0.15)", marginTop: 3 }}>{ch.provider}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>)}

        {/* SETTINGS */}
        {view === "settings" && (<div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, marginBottom: 18 }}>Settings</h1>
          {[
            { s: "Organisation", items: [{ l: "Company", v: "Zenith Legal Services Group Ltd (16902595)" }, { l: "Account Manager", v: "Jamie Anderson" }] },
            ...(CURRENT_USER.role === "admin" ? [{
              s: "Clients", items: clients.map(c => ({ l: c.name, v: `Contact: ${c.contact_name || "Not set"}`, dot: c.color, a: "Edit", onClick: () => setShowClientModal(c) })).concat([{ l: "+ Add New Client", v: "Create a new client account", a: "Add", onClick: () => setShowClientModal({}) }])
            }] : []),
            ...(CURRENT_USER.role === "admin" ? [{
              s: "Users & Access", items: [
                ...(users || []).map(u => ({ l: u.name, v: `${u.role.charAt(0).toUpperCase() + u.role.slice(1)} - ${u.clients?.name || "All clients"}`, dot: "#10b981" })),
                { l: "Invite User", v: "Add a case manager or viewer", a: "Invite", onClick: () => setShowUserModal(true) },
              ]
            }] : []),
            { s: "Integrations", items: [
              { l: "Stripe", v: health.stripe ? "Connected" : "Not configured", st: health.stripe ? "live" : "off", a: "Configure" },
              { l: "Vapi (AI Voice)", v: health.vapi ? "Connected" : "Not configured - add VAPI_API_KEY in Railway", st: health.vapi ? "live" : "off", a: "Configure" },
              { l: "Twilio (SMS + WhatsApp)", v: health.twilio ? "Connected" : "Not configured - add TWILIO keys in Railway", st: health.twilio ? "live" : "off", a: "Configure" },
              { l: "SendGrid (Email)", v: health.sendgrid ? "Connected" : "Not configured - add SENDGRID_API_KEY in Railway", st: health.sendgrid ? "live" : "off", a: "Configure" },
              { l: "Claude API (Intelligence)", v: health.anthropic ? "Connected" : "Not configured", st: health.anthropic ? "live" : "off", a: "Configure" },
            ]},
            { s: "Commercial Defaults", items: [
              { l: "Default Daily Interest", v: "£79.00/day", a: "Edit" },
              { l: "Interest Basis", v: "Late Payment of Commercial Debts Act 1998", a: "Edit" },
              { l: "Auto-update Stripe links", v: "Enabled (recalculates daily)", a: "Toggle" },
            ]},
            { s: "Sequence Rules", items: [
              { l: "Auto-pause on dispute", v: "Enabled", a: "Toggle" },
              { l: "Auto-pause on payment", v: "Enabled", a: "Toggle" },
              { l: "Working hours", v: "09:00-18:00 Mon-Fri", a: "Edit" },
              { l: "Human handoff triggers", v: "hostile, vulnerable, solicitor, dispute", a: "Edit" },
            ]},
          ].map((g, gi) => (
            <div key={gi} style={{ marginBottom: 20 }}>
              <h3 style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1, fontFamily: "var(--mono)" }}>{g.s}</h3>
              <div style={{ background: "rgba(255,255,255,0.015)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: 8, overflow: "hidden" }}>
                {g.items.map((item, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 13px", borderBottom: i < g.items.length - 1 ? "1px solid rgba(255,255,255,0.03)" : "none" }}>
                    <div><div style={{ fontSize: 12 }}>{item.l}</div><div style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", fontFamily: "var(--mono)", marginTop: 1 }}>{item.v}</div></div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      {item.st && <div style={{ width: 5, height: 5, borderRadius: 3, background: item.st === "live" ? "#10b981" : "#ef4444" }} />}
                      {item.dot && <div style={{ width: 5, height: 5, borderRadius: 3, background: item.dot }} />}
                      {item.a && <button onClick={item.onClick} style={{ padding: "4px 9px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 4, color: "rgba(255,255,255,0.3)", cursor: "pointer", fontSize: 9 }}>{item.a}</button>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>)}
      </div>

      {selected && <DebtorPanel debtor={selected} onClose={() => setSelected(null)} onRefresh={refreshDebtors} />}
      {showAdd && <AddDebtorModal onClose={() => setShowAdd(false)} onAdd={handleAdd} />}
      {showClientModal !== null && (
        <ClientModal
          client={showClientModal}
          onClose={() => setShowClientModal(null)}
          onSave={async (form) => {
            if (showClientModal.id) await updateClient(showClientModal.id, form);
            else await addClient(form);
          }}
        />
      )}
      {showUserModal && (
        <UserModal
          clients={clients}
          onClose={() => setShowUserModal(false)}
          onSave={async (form) => { await inviteUser(form.email, form.name, form.role, form.client_id || null); }}
        />
      )}
    </div>
  );
}
