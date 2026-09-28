import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Heart, Wind, Thermometer, AlertTriangle, Bell, Phone,
  UserPlus, CheckCircle, Activity, Stethoscope, Send,
  Trash2, Shield, ChevronRight, LayoutDashboard,
  Wifi, WifiOff, User, PhoneCall, PhoneOff, Radio,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type VStatus    = "normal" | "warning" | "critical";
type SimMode    = "normal" | "alerta";
type ChartTab   = "hr" | "rr" | "temp";
type MobileTab  = "sinais" | "alertas" | "saude" | "contatos";
type MotionState = "active" | "idle" | "dormant";
type EcgView    = "ecg" | "sensor";

type ChartConfig = {
  dataKey: string; name: string; unit: string; color: string;
  domain: [number, number]; refLo: number; refHi: number;
};

const THINGSPEAK_URL =
  "https://thingspeak.com/channels/3475870/charts/1?bgcolor=%23ffffff&color=%23d62020&dynamic=true&results=60&type=line&update=15";

// ─── Constants ────────────────────────────────────────────────────────────────

const COLOR: Record<VStatus, string> = {
  normal:   "#00D4A8",
  warning:  "#F5A623",
  critical: "#FF4B6E",
};
const LABEL: Record<VStatus, string> = {
  normal: "Normal", warning: "Atenção", critical: "Crítico",
};

const ACTIVE_MS   = 5_000;   // < 5s  → active
const IDLE_MS     = 20_000;  // < 20s → idle (else dormant)
const COUNTDOWN_S = 30;      // seconds before SOS fires

// ─── Domain helpers ───────────────────────────────────────────────────────────

function classify(v: number, wLo: number, wHi: number, cLo: number, cHi: number): VStatus {
  if (v < cLo || v > cHi) return "critical";
  if (v < wLo || v > wHi) return "warning";
  return "normal";
}
const hrSt   = (v: number) => classify(v, 60, 100, 45, 130);
const rrSt   = (v: number) => classify(v, 12, 20,   8,  28);
const tempSt = (v: number) => classify(v, 36.0, 37.5, 35.0, 38.5);

function overallSt(hr: number, rr: number, temp: number): VStatus {
  const s = [hrSt(Math.round(hr)), rrSt(Math.round(rr)), tempSt(temp)];
  if (s.includes("critical")) return "critical";
  if (s.includes("warning"))  return "warning";
  return "normal";
}

interface Contact { id: number; name: string; relation: string; phone: string; }
interface IrregEvent { id: number; ts: Date; label: string; value: string; status: VStatus; }
interface HistoryPoint { t: string; hr: number; rr: number; temp: number; }

const DEFAULT_CONTACTS: Contact[] = [
  { id: 1, name: "Dr. Marcos Ribeiro",   relation: "Cardiologista",    phone: "(11) 98765-4321" },
  { id: 2, name: "Ana Lima",             relation: "Filha — Familiar", phone: "(21) 99234-5678" },
  { id: 3, name: "SAMU",                 relation: "Emergência",       phone: "192" },
];

function getRecommendations(hr: number, rr: number, temp: number) {
  const recs: { text: string; status: VStatus; action?: string }[] = [];
  if      (hr > 130) recs.push({ text: "Taquicardia severa (FC > 130 bpm). Risco cardíaco elevado.", status: "critical", action: "Ligue 192 agora" });
  else if (hr > 100) recs.push({ text: "Frequência cardíaca elevada. Evite esforço e busque avaliação.", status: "warning", action: "Agende consulta" });
  else if (hr < 45)  recs.push({ text: "Bradicardia severa (FC < 45 bpm). Emergência médica.", status: "critical", action: "Ligue 192 agora" });
  else if (hr < 60)  recs.push({ text: "FC abaixo do normal. Monitore e consulte se persistir.", status: "warning" });
  if      (rr > 28)  recs.push({ text: "Desconforto respiratório severo. Atenção imediata.", status: "critical", action: "Ligue 192 agora" });
  else if (rr > 20)  recs.push({ text: "Frequência respiratória acima do normal. Repouso.", status: "warning" });
  else if (rr < 8)   recs.push({ text: "Respiração muito lenta. Avaliação urgente necessária.", status: "critical", action: "Ligue 192 agora" });
  else if (rr < 12)  recs.push({ text: "FR levemente baixa. Monitore de perto.", status: "warning" });
  if      (temp > 38.5) recs.push({ text: "Febre alta. Busque atendimento médico.", status: "critical", action: "Consulta urgente" });
  else if (temp > 37.5) recs.push({ text: "Febre leve. Hidratação, repouso e monitoramento.", status: "warning" });
  else if (temp < 35.0) recs.push({ text: "Hipotermia detectada. Atendimento imediato.", status: "critical", action: "Ligue 192 agora" });
  if (recs.length === 0)
    recs.push({ text: "Todos os sinais vitais estão dentro dos parâmetros normais. Continue monitorando.", status: "normal" });
  return recs;
}

// ─── ECG Canvas ───────────────────────────────────────────────────────────────

function ecgAmp(p: number): number {
  const x = ((p % 1) + 1) % 1;
  if (x < 0.07)  return 0;
  if (x < 0.17)  return Math.sin((x - 0.07) / 0.10 * Math.PI) * 0.13;
  if (x < 0.21)  return 0;
  if (x < 0.235) return -0.07;
  if (x < 0.27)  return Math.sin((x - 0.235) / 0.035 * Math.PI) * 1.0;
  if (x < 0.31)  return -0.15;
  if (x < 0.37)  return Math.exp(-(x - 0.31) * 25) * -0.04;
  if (x < 0.54)  return Math.sin((x - 0.37) / 0.17 * Math.PI) * 0.26;
  return 0;
}

function ECGWave({ bpm, status }: { bpm: number; status: VStatus }) {
  const ref   = useRef<HTMLCanvasElement>(null);
  const rafR  = useRef(0);
  const phase = useRef(0);
  const color = COLOR[status];
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const parent = canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.max(200, parent.offsetWidth)  * dpr;
    canvas.height = Math.max(48,  parent.offsetHeight) * dpr;
    let alive = true;
    const draw = () => {
      if (!alive) return;
      const ctx = canvas.getContext("2d")!;
      const W = canvas.width, H = canvas.height;
      const ppb = (W * 60) / (bpm * 3.6);
      const spd = Math.max(0.8, (bpm / 60) * 2.2 * dpr);
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(255,255,255,0.045)"; ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 40 * dpr) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
      for (let y = 0; y < H; y += 22 * dpr) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2*dpr;
      ctx.shadowColor = color; ctx.shadowBlur = 10; ctx.lineJoin = "round";
      for (let px = 0; px < W; px++) {
        const py = H*0.5 - ecgAmp((phase.current+px)/ppb)*H*0.36;
        px===0 ? ctx.moveTo(px,py) : ctx.lineTo(px,py);
      }
      ctx.stroke(); ctx.shadowBlur = 0;
      const fw = 48*dpr;
      const fl = ctx.createLinearGradient(0,0,fw,0);
      fl.addColorStop(0,"rgba(14,21,37,1)"); fl.addColorStop(1,"rgba(14,21,37,0)");
      ctx.fillStyle=fl; ctx.fillRect(0,0,fw,H);
      const fr = ctx.createLinearGradient(W-fw,0,W,0);
      fr.addColorStop(0,"rgba(14,21,37,0)"); fr.addColorStop(1,"rgba(14,21,37,1)");
      ctx.fillStyle=fr; ctx.fillRect(W-fw,0,fw,H);
      phase.current = (phase.current+spd) % (ppb*8);
      rafR.current = requestAnimationFrame(draw);
    };
    rafR.current = requestAnimationFrame(draw);
    return () => { alive=false; cancelAnimationFrame(rafR.current); };
  }, [bpm, color]);
  return <canvas ref={ref} className="w-full h-full block" />;
}

// ─── Motion Sensor Card ───────────────────────────────────────────────────────

function MotionSensorCard({
  state, secondsAgo, accelGranted, onEnableAccel, countdown,
}: {
  state: MotionState;
  secondsAgo: number;
  accelGranted: boolean;
  onEnableAccel: () => void;
  countdown: number | null;
}) {
  const stColor =
    countdown !== null ? "#FF4B6E" :
    state === "active"  ? "#00D4A8" :
    state === "idle"    ? "#F5A623" : "#FF4B6E";

  const stLabel =
    countdown !== null   ? `SOS em ${countdown}s — mova o dispositivo` :
    state === "active"   ? "Movimento detectado" :
    state === "idle"     ? `Inativo há ${secondsAgo}s` :
                           "Sem resposta detectada";

  const barWidth =
    state === "active" ? 100 :
    state === "idle"   ? Math.max(8, 100 - (secondsAgo / (IDLE_MS / 1000)) * 100) : 4;

  return (
    <div
      className="rounded-xl border p-5 relative overflow-hidden"
      style={{ background: "#0E1525", borderColor: `${stColor}28` }}
    >
      {/* Ambient glow */}
      <div className="absolute inset-0 pointer-events-none"
        style={{ background: `radial-gradient(ellipse at left center, ${stColor}0C 0%, transparent 70%)` }} />

      <div className="flex items-center gap-4">
        {/* Animated sensor orb */}
        <div className="relative w-16 h-16 shrink-0 flex items-center justify-center">
          {(state === "active" || countdown !== null) && (
            <>
              <div className="absolute inset-0 rounded-full animate-ping"
                style={{ background: `${stColor}18`, animationDuration: "1.2s" }} />
              <div className="absolute inset-[-8px] rounded-full animate-ping"
                style={{ background: `${stColor}08`, animationDuration: "1.2s", animationDelay: "0.4s" }} />
            </>
          )}
          {state === "dormant" && countdown === null && (
            <div className="absolute inset-0 rounded-full animate-pulse"
              style={{ background: `${stColor}22`, animationDuration: "2s" }} />
          )}
          <div className="w-14 h-14 rounded-full flex items-center justify-center relative z-10"
            style={{ background: `${stColor}14`, border: `2px solid ${stColor}` }}>
            <User size={24} style={{ color: stColor }} />
          </div>
        </div>

        {/* Status text */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-bold tracking-widest uppercase text-white/30">
              Sensor de Movimento
            </span>
            {accelGranted && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold"
                style={{ background: "#00D4A812", color: "#00D4A8" }}>
                Acelerômetro ativo
              </span>
            )}
          </div>
          <div className="font-bold text-base leading-tight" style={{ color: stColor }}>{stLabel}</div>
          <div className="text-white/35 text-xs mt-1">
            {accelGranted
              ? "Detectando movimento físico do dispositivo"
              : "Detectando toques, cliques e movimentos de tela"}
          </div>
        </div>

        {/* Enable accelerometer */}
        {!accelGranted && (
          <button onClick={onEnableAccel}
            className="shrink-0 flex flex-col items-center gap-1.5 text-[10px] px-3 py-2.5 rounded-lg font-semibold transition-all"
            style={{ background: "#00D4A812", color: "#00D4A8" }}>
            <Wifi size={16} />
            Ativar
          </button>
        )}
      </div>

      {/* Activity bar */}
      <div className="mt-4 h-2 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.07)" }}>
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ background: stColor, width: `${barWidth}%` }}
        />
      </div>

      {/* Status row */}
      <div className="flex items-center justify-between mt-2.5">
        <span className="text-[10px] text-white/30 font-mono">
          {state === "active" ? "Paciente respondendo" :
           state === "idle"   ? "Aguardando movimento..." :
                                "Sem resposta — verificar paciente"}
        </span>
        <span
          className="text-[10px] px-2 py-0.5 rounded font-bold"
          style={{ background: `${stColor}18`, color: stColor }}
        >
          {state === "active" ? "● ATIVO" : state === "idle" ? "◐ INATIVO" : "○ DORMINDO"}
        </span>
      </div>
    </div>
  );
}

// ─── Countdown Overlay ────────────────────────────────────────────────────────

function CountdownOverlay({ countdown, onConfirm }: { countdown: number; onConfirm: () => void }) {
  const pct = (countdown / COUNTDOWN_S) * 100;
  const r = 44, circ = 2 * Math.PI * r;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      style={{ background: "rgba(8,13,24,0.92)", backdropFilter: "blur(6px)" }}
    >
      <div
        className="w-full max-w-sm rounded-2xl p-6 border"
        style={{ background: "#0E1525", borderColor: "#FF4B6E40" }}
      >
        {/* Circular countdown */}
        <div className="flex justify-center mb-5">
          <div className="relative w-28 h-28 flex items-center justify-center">
            <svg className="absolute inset-0 -rotate-90" width="112" height="112" viewBox="0 0 112 112">
              <circle cx="56" cy="56" r={r} fill="none" stroke="rgba(255,75,110,0.12)" strokeWidth="6" />
              <circle
                cx="56" cy="56" r={r} fill="none"
                stroke="#FF4B6E" strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={circ}
                strokeDashoffset={circ * (1 - pct / 100)}
                style={{ transition: "stroke-dashoffset 0.9s linear" }}
              />
            </svg>
            <div className="relative z-10 text-center">
              <div
                className="text-4xl font-bold leading-none tabular-nums"
                style={{ color: "#FF4B6E", fontFamily: "'JetBrains Mono', monospace" }}
              >
                {countdown}
              </div>
              <div className="text-white/30 text-[9px] mt-0.5">segundos</div>
            </div>
          </div>
        </div>

        {/* Warning icon + title */}
        <div className="flex justify-center mb-2">
          <div className="w-8 h-8 rounded-full flex items-center justify-center animate-pulse"
            style={{ background: "#FF4B6E18" }}>
            <AlertTriangle size={16} style={{ color: "#FF4B6E" }} />
          </div>
        </div>

        <h2
          className="text-white text-xl font-bold text-center mb-2"
          style={{ fontFamily: "'DM Serif Display', serif" }}
        >
          Você está bem?
        </h2>
        <p className="text-white/42 text-sm text-center mb-6 leading-relaxed">
          Irregularidade detectada e nenhum movimento registrado. Os contatos de emergência serão notificados automaticamente se não houver resposta.
        </p>

        {/* Confirm button */}
        <button
          onClick={onConfirm}
          className="w-full py-4 rounded-xl text-lg font-bold transition-all active:scale-95 mb-3 flex items-center justify-center gap-2"
          style={{ background: "#00D4A8", color: "#000" }}
        >
          <CheckCircle size={20} />
          Estou bem
        </button>

        <div className="text-center text-white/22 text-xs">
          SOS automático em{" "}
          <span style={{ color: "#FF4B6E", fontFamily: "'JetBrains Mono', monospace" }}>
            {countdown}s
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── SOS Banner ───────────────────────────────────────────────────────────────

function SOSBanner({ contacts, onDismiss }: { contacts: Contact[]; onDismiss: () => void }) {
  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 px-4 py-3 flex items-center gap-3"
      style={{ background: "#FF4B6E", boxShadow: "0 4px 24px rgba(255,75,110,0.5)" }}
    >
      <AlertTriangle size={18} className="text-white shrink-0 animate-pulse" />
      <div className="flex-1 min-w-0">
        <div className="text-white font-bold text-sm">SOS ENVIADO — Contatos notificados</div>
        <div className="text-white/70 text-xs truncate">
          {contacts.map(c => c.name.split(" ")[0]).join(", ")} foram avisados
        </div>
      </div>
      <button onClick={onDismiss} className="text-white/70 hover:text-white shrink-0 text-lg leading-none">×</button>
    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function LiveClock({ className = "" }: { className?: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    <span className={className} style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      {p(now.getHours())}:{p(now.getMinutes())}:{p(now.getSeconds())}
    </span>
  );
}


function TrendChart({ height = 140, hrR, rrR, temp, chartTab, setChartTab, history, cc }: {
  height?: number;
  hrR: number; rrR: number; temp: number;
  chartTab: ChartTab; setChartTab: (t: ChartTab) => void;
  history: HistoryPoint[]; cc: ChartConfig;
}) {
  const VB_W = 400;
  const VB_H = height - 8;
  const [dMin, dMax] = cc.domain;
  const clamp = (v: number) => Math.max(0, Math.min(VB_H, VB_H - ((v - dMin) / (dMax - dMin)) * VB_H));
  const vals = history.map(p => (p as Record<string, number>)[cc.dataKey]);
  const pts = vals.map((v, i) => {
    const x = vals.length < 2 ? 0 : (i / (vals.length - 1)) * VB_W;
    return `${x.toFixed(1)},${clamp(v).toFixed(1)}`;
  }).join(" ");
  const area = vals.length > 1 ? `0,${VB_H} ${pts} ${VB_W},${VB_H}` : "";
  const refLoY = clamp(cc.refLo);
  const refHiY = clamp(cc.refHi);

  return (
    <div className="rounded-xl border border-white/[0.05] p-4" style={{ background:"#0E1525" }}>
      <div className="flex items-center gap-1 mb-3 flex-wrap">
        {(["hr","rr","temp"] as ChartTab[]).map(tab => {
          const c = tab==="hr" ? COLOR[hrSt(hrR)] : tab==="rr" ? COLOR[rrSt(rrR)] : COLOR[tempSt(temp)];
          return (
            <button key={tab} onClick={() => setChartTab(tab)}
              className="text-[11px] px-2.5 py-1 rounded-lg font-semibold transition-all"
              style={chartTab===tab ? {background:`${c}1E`,color:c} : {background:"transparent",color:"rgba(255,255,255,0.28)"}}>
              {tab==="hr" ? "Cardíaca" : tab==="rr" ? "Respiratória" : "Temperatura"}
            </button>
          );
        })}
        <span className="ml-auto text-[9px] text-white/18 font-mono">{history.length} leituras</span>
      </div>
      <div style={{ height }}>
        <svg width="100%" height="100%" viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none">
          {/* grid lines */}
          {[0.25, 0.5, 0.75].map(f => (
            <line key={f} x1={0} y1={f * VB_H} x2={VB_W} y2={f * VB_H}
              stroke="rgba(255,255,255,0.04)" strokeWidth={1}/>
          ))}
          {/* reference bands */}
          <line x1={0} y1={refLoY} x2={VB_W} y2={refLoY}
            stroke="rgba(255,255,255,0.14)" strokeDasharray="4 4" strokeWidth={1}/>
          <line x1={0} y1={refHiY} x2={VB_W} y2={refHiY}
            stroke="rgba(255,255,255,0.14)" strokeDasharray="4 4" strokeWidth={1}/>
          {/* area fill */}
          {area && <polygon points={area} fill={cc.color} fillOpacity={0.12}/>}
          {/* stroke line */}
          {vals.length > 1 && (
            <polyline points={pts} fill="none" stroke={cc.color} strokeWidth={2}
              strokeLinejoin="round" strokeLinecap="round"/>
          )}
        </svg>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  // ── Vitals ──────────────────────────────────────────────────────────────────
  const [hr,   setHr]   = useState(72);
  const [rr,   setRr]   = useState(15);
  const [temp, setTemp] = useState(36.6);
  const [simMode,  setSimMode]  = useState<SimMode>("normal");
  const [chartTab, setChartTab] = useState<ChartTab>("hr");
  const [mobileTab, setMobileTab] = useState<MobileTab>("sinais");
  const [history,  setHistory]  = useState<HistoryPoint[]>([]);
  const [events,   setEvents]   = useState<IrregEvent[]>([]);
  const eventId = useRef(1);
  const simTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Contacts ────────────────────────────────────────────────────────────────
  const [contacts,   setContacts]   = useState<Contact[]>(DEFAULT_CONTACTS);
  const [showForm,   setShowForm]   = useState(false);
  const [newContact, setNewContact] = useState({ name: "", relation: "", phone: "" });
  const [notified,   setNotified]   = useState<Record<number, "sending" | "sent">>({});

  // ── Motion detection ────────────────────────────────────────────────────────
  const lastActivityRef  = useRef(Date.now());
  const cntRef           = useRef<number | null>(null);       // countdown value in ref
  const sosRef           = useRef(false);                     // SOS triggered
  const eventsRef        = useRef<IrregEvent[]>([]);          // always-current events
  const contactsRef      = useRef<Contact[]>(DEFAULT_CONTACTS);
  const prevAccelRef     = useRef({ x: 0, y: 0, z: 9.8 });  // for delta detection

  const [motionState,       setMotionState]       = useState<MotionState>("active");
  const [secondsSinceAct,   setSecondsSinceAct]   = useState(0);
  const [countdown,         setCountdown]         = useState<number | null>(null);
  const [sosTriggered,      setSosTriggered]       = useState(false);
  const [accelGranted,      setAccelGranted]       = useState(false);
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia("(min-width: 768px)").matches);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Keep refs in sync with state
  useEffect(() => { eventsRef.current = events; }, [events]);
  useEffect(() => { contactsRef.current = contacts; }, [contacts]);

  // Register UI activity listeners
  useEffect(() => {
    const bump = () => { lastActivityRef.current = Date.now(); };
    const opts = { passive: true } as const;
    window.addEventListener("mousemove",  bump, opts);
    window.addEventListener("touchstart", bump, opts);
    window.addEventListener("touchmove",  bump, opts);
    window.addEventListener("click",      bump);
    window.addEventListener("keydown",    bump);
    window.addEventListener("scroll",     bump, opts);
    return () => {
      window.removeEventListener("mousemove",  bump);
      window.removeEventListener("touchstart", bump);
      window.removeEventListener("touchmove",  bump);
      window.removeEventListener("click",      bump);
      window.removeEventListener("keydown",    bump);
      window.removeEventListener("scroll",     bump);
    };
  }, []);

  // Accelerometer permission + listener
  const enableAccelerometer = useCallback(async () => {
    try {
      if (typeof (DeviceMotionEvent as any).requestPermission === "function") {
        const perm = await (DeviceMotionEvent as any).requestPermission();
        if (perm !== "granted") return;
      }
      setAccelGranted(true);
    } catch {
      setAccelGranted(true); // non-iOS: no permission needed
    }
  }, []);

  useEffect(() => {
    if (!accelGranted) return;
    const handler = (e: DeviceMotionEvent) => {
      const a = e.acceleration ?? e.accelerationIncludingGravity;
      if (!a) return;
      const curr = { x: a.x ?? 0, y: a.y ?? 0, z: a.z ?? 0 };
      const prev = prevAccelRef.current;
      const delta = Math.sqrt(
        (curr.x - prev.x) ** 2 + (curr.y - prev.y) ** 2 + (curr.z - prev.z) ** 2
      );
      prevAccelRef.current = curr;
      if (delta > 1.2) lastActivityRef.current = Date.now(); // significant movement
    };
    window.addEventListener("devicemotion", handler);
    return () => window.removeEventListener("devicemotion", handler);
  }, [accelGranted]);

  // Main monitoring loop — uses refs to avoid stale closures
  useEffect(() => {
    const tick = setInterval(() => {
      const elapsed = Date.now() - lastActivityRef.current;
      const secs    = Math.floor(elapsed / 1000);
      setSecondsSinceAct(secs);

      const ms: MotionState =
        elapsed < ACTIVE_MS ? "active" :
        elapsed < IDLE_MS   ? "idle"   : "dormant";
      setMotionState(ms);

      // If user moves, cancel active countdown
      if (ms !== "dormant" && cntRef.current !== null) {
        cntRef.current = null;
        setCountdown(null);
      }

      // Trigger countdown when dormant + irregularity detected + not already in SOS
      if (ms === "dormant" && eventsRef.current.length > 0 && cntRef.current === null && !sosRef.current) {
        cntRef.current = COUNTDOWN_S;
        setCountdown(COUNTDOWN_S);
      }

      // Tick active countdown
      if (cntRef.current !== null) {
        const next = cntRef.current - 1;
        if (next <= 0) {
          // 🚨 SOS!
          cntRef.current = null;
          sosRef.current = true;
          setCountdown(null);
          setSosTriggered(true);
          const sending: Record<number, "sending" | "sent"> = {};
          contactsRef.current.forEach(c => { sending[c.id] = "sending"; });
          setNotified(sending);
          setTimeout(() => {
            const sent: Record<number, "sending" | "sent"> = {};
            contactsRef.current.forEach(c => { sent[c.id] = "sent"; });
            setNotified(sent);
          }, 2000);
        } else {
          cntRef.current = next;
          setCountdown(next);
        }
      }
    }, 1000);
    return () => clearInterval(tick);
  }, []); // intentionally empty — reads only refs

  // ── Simulation ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const em = simMode === "alerta";
      setHr  (p => Math.max(40, Math.min(180, p + (em ? 128  : 74   - p) * 0.09 + (Math.random() - 0.5) * (em ? 9    : 4   ))));
      setRr  (p => Math.max(6,  Math.min(35,  p + (em ? 25   : 15   - p) * 0.07 + (Math.random() - 0.5) * (em ? 3    : 1.5 ))));
      setTemp(p => Math.max(34, Math.min(42,  p + (em ? 38.9 : 36.6 - p) * 0.04 + (Math.random() - 0.5) * (em ? 0.18 : 0.07))));
    }, 1500);
    return () => clearInterval(id);
  }, [simMode]);

  // ── History + irregularity detection ────────────────────────────────────────
  useEffect(() => {
    const now = new Date();
    const ts  = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
    const hrR = Math.round(hr), rrR = Math.round(rr);
    setHistory(p => [...p, { t: ts, hr: hrR, rr: rrR, temp: parseFloat(temp.toFixed(1)) }].slice(-60));
    const hS = hrSt(hrR), rS = rrSt(rrR), tS = tempSt(temp);
    const ne: IrregEvent[] = [];
    if (hS !== "normal") ne.push({ id: eventId.current++, ts: now, label: "Freq. Cardíaca",      value: `${hrR} bpm`,            status: hS });
    if (rS !== "normal") ne.push({ id: eventId.current++, ts: now, label: "Freq. Respiratória",  value: `${rrR} rpm`,            status: rS });
    if (tS !== "normal") ne.push({ id: eventId.current++, ts: now, label: "Temperatura",          value: `${temp.toFixed(1)} °C`, status: tS });
    if (ne.length) setEvents(p => [...ne, ...p].slice(0, 40));
  }, [hr, rr, temp]); // eslint-disable-line

  // ── Derived ─────────────────────────────────────────────────────────────────
  const overall = useMemo(() => overallSt(hr, rr, temp), [hr, rr, temp]);
  const recs    = useMemo(() => getRecommendations(Math.round(hr), Math.round(rr), temp), [hr, rr, temp]);
  const hrR = Math.round(hr), rrR = Math.round(rr);
  const critCount = events.filter(e => e.status === "critical").length;

  const confirmAlive = () => {
    cntRef.current = null;
    sosRef.current = false;
    lastActivityRef.current = Date.now();
    setCountdown(null);
    setSosTriggered(false);
  };

  const toggleSim = () => {
    if (simMode === "alerta") { setSimMode("normal"); if (simTimer.current) clearTimeout(simTimer.current); }
    else { setSimMode("alerta"); simTimer.current = setTimeout(() => setSimMode("normal"), 30_000); }
  };

  const handleNotify = (cid: number) => {
    setNotified(p => ({ ...p, [cid]: "sending" }));
    setTimeout(() => setNotified(p => ({ ...p, [cid]: "sent" })), 1800);
  };

  const addContact = () => {
    if (!newContact.name.trim()) return;
    setContacts(p => [...p, { ...newContact, id: Date.now() }]);
    setNewContact({ name: "", relation: "", phone: "" });
    setShowForm(false);
  };

  const fmtTs = (d: Date) =>
    `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;

  const CHART_CFG = {
    hr:   { dataKey:"hr",   name:"FC",   unit:" bpm", color:COLOR[hrSt(hrR)],    domain:[40,160]  as [number,number], refLo:60,   refHi:100  },
    rr:   { dataKey:"rr",   name:"FR",   unit:" rpm", color:COLOR[rrSt(rrR)],    domain:[6,35]    as [number,number], refLo:12,   refHi:20   },
    temp: { dataKey:"temp", name:"Temp", unit:" °C",  color:COLOR[tempSt(temp)], domain:[34,41]   as [number,number], refLo:36.0, refHi:37.5 },
  };
  const cc = CHART_CFG[chartTab];

  const vitals = [
    { unit:"bpm", icon:<Heart size={14} fill="currentColor"/>, status:hrSt(hrR),    value:hrR,            label:"Freq.\nCardíaca",     sub: hrR>100?"Taquicardia":hrR<60?"Bradicardia":"Normal" },
    { unit:"rpm", icon:<Wind size={14}/>,                      status:rrSt(rrR),    value:rrR,            label:"Freq.\nRespiratória", sub: rrR>20?"Taquipneia":rrR<12?"Bradipneia":"Normal"    },
    { unit:"°C",  icon:<Thermometer size={14}/>,               status:tempSt(temp), value:temp.toFixed(1),label:"Tempe-\nratura",      sub: temp>38.5?"Febre Alta":temp>37.5?"Febre":temp<35?"Hipotermia":"Afebril" },
  ];

  // ── Reusable sections ────────────────────────────────────────────────────────

  const VitalCards = ({ compact = false }: { compact?: boolean }) => (
    <div className="grid grid-cols-3 gap-2.5">
      {vitals.map(v => (
        <div key={v.unit} className={`rounded-xl border border-white/[0.05] relative overflow-hidden ${compact ? "p-3" : "p-4"}`}
          style={{ background: "#0E1525" }}>
          <div className="absolute inset-0 pointer-events-none"
            style={{ background:`radial-gradient(ellipse at top right, ${COLOR[v.status]}14 0%, transparent 65%)` }} />
          <div className="flex items-center justify-between mb-2">
            <span style={{ color:COLOR[v.status] }} className="opacity-60">{v.icon}</span>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background:COLOR[v.status] }} />
          </div>
          <div className={`font-bold tabular-nums leading-none ${compact ? "text-2xl" : "text-[2.1rem]"}`}
            style={{ color:COLOR[v.status], fontFamily:"'JetBrains Mono', monospace" }}>{v.value}</div>
          <div className="text-white/28 text-[10px] mt-0.5 font-mono">{v.unit}</div>
          <div className="text-[10px] mt-1.5 font-semibold truncate" style={{ color:COLOR[v.status] }}>{v.sub}</div>
        </div>
      ))}
    </div>
  );

  const EventsLog = () => (
    <div className="rounded-xl border border-white/[0.05] p-4" style={{ background:"#0E1525" }}>
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle size={12} className="text-[#FF4B6E]"/>
        <span className="text-white/50 text-xs font-semibold tracking-wide">Irregularidades Detectadas</span>
        {critCount > 0 && (
          <span className="ml-auto text-[9px] px-2 py-0.5 rounded-full font-bold" style={{background:"#FF4B6E18",color:"#FF4B6E"}}>
            {critCount} crítico(s)
          </span>
        )}
      </div>
      {events.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-6 text-white/20">
          <Shield size={15}/><span className="text-xs">Nenhuma irregularidade detectada</span>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {events.slice(0, 10).map(ev => (
            <div key={ev.id} className="flex items-center gap-2 rounded-lg px-3 py-2 border text-xs"
              style={{background:`${COLOR[ev.status]}08`,borderColor:`${COLOR[ev.status]}1E`}}>
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{background:COLOR[ev.status]}}/>
              <span className="text-white/24 text-[10px] shrink-0 tabular-nums" style={{fontFamily:"'JetBrains Mono', monospace"}}>{fmtTs(ev.ts)}</span>
              <span className="text-white/45 flex-1 truncate">{ev.label}</span>
              <span className="font-bold tabular-nums" style={{color:COLOR[ev.status],fontFamily:"'JetBrains Mono', monospace"}}>{ev.value}</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold shrink-0"
                style={{background:`${COLOR[ev.status]}18`,color:COLOR[ev.status]}}>{LABEL[ev.status]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const RecsPanel = () => (
    <div className="rounded-xl border border-white/[0.05] p-4" style={{ background:"#0E1525" }}>
      <div className="flex items-center gap-2 mb-3">
        <Stethoscope size={13} style={{color:"#7B8FFF"}}/>
        <span className="text-white/55 text-xs font-semibold tracking-wide">Recomendação Médica</span>
      </div>
      <div className="flex flex-col gap-2">
        {recs.map((rec, i) => (
          <div key={i} className="rounded-lg p-3 border text-xs"
            style={{background:`${COLOR[rec.status]}0A`,borderColor:`${COLOR[rec.status]}22`}}>
            <div className="flex items-start gap-2">
              <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-[3px]" style={{background:COLOR[rec.status]}}/>
              <div className="flex-1">
                <p className="text-white/65 leading-snug">{rec.text}</p>
                {rec.action && (
                  <span className="inline-flex items-center gap-1 mt-2 text-[10px] font-bold px-2 py-0.5 rounded"
                    style={{background:`${COLOR[rec.status]}22`,color:COLOR[rec.status]}}>
                    <ChevronRight size={9}/>{rec.action}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const ContactsPanel = () => (
    <>
      <div className="rounded-xl border border-white/[0.05] p-4" style={{background:"#0E1525"}}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Phone size={13} style={{color:"#00D4A8"}}/>
            <span className="text-white/55 text-xs font-semibold tracking-wide">Contatos de Emergência</span>
          </div>
          {overall !== "normal" && (
            <button onClick={() => contacts.forEach(c => handleNotify(c.id))}
              className="flex items-center gap-1 text-[10px] px-2.5 py-1 rounded-lg font-bold border"
              style={{background:"#FF4B6E15",borderColor:"#FF4B6E30",color:"#FF4B6E"}}>
              <Bell size={9}/> Avisar Todos
            </button>
          )}
        </div>
        <div className="flex flex-col gap-2">
          {contacts.map(c => {
            const ns = notified[c.id];
            return (
              <div key={c.id} className="rounded-lg p-3 border border-white/[0.05] flex items-center gap-3"
                style={{background:"#131929"}}>
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
                  style={{background:"#1A2540",color:"#00D4A8"}}>{c.name.charAt(0)}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-white/75 text-sm font-semibold truncate">{c.name}</div>
                  <div className="text-white/30 text-xs">{c.relation}</div>
                  <div className="text-white/22 text-xs font-mono tabular-nums" style={{fontFamily:"'JetBrains Mono', monospace"}}>{c.phone}</div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  {ns==="sent" ? (
                    <span className="flex items-center gap-1 text-[11px]" style={{color:"#00D4A8"}}><CheckCircle size={11}/> Enviado</span>
                  ) : (
                    <button onClick={() => handleNotify(c.id)} disabled={ns==="sending"}
                      className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg font-semibold"
                      style={{background:overall!=="normal"?"#FF4B6E14":"#00D4A814",color:overall!=="normal"?"#FF4B6E":"#00D4A8",opacity:ns==="sending"?0.5:1}}>
                      <Send size={9}/>{ns==="sending"?"Enviando…":"Avisar"}
                    </button>
                  )}
                  <button onClick={() => setContacts(p => p.filter(x => x.id !== c.id))}
                    className="text-white/14 hover:text-[#FF4B6E] transition-colors"><Trash2 size={10}/></button>
                </div>
              </div>
            );
          })}
        </div>
        {showForm ? (
          <div className="mt-2 rounded-lg p-3 border border-white/[0.07]" style={{background:"#131929"}}>
            <div className="flex flex-col gap-2">
              {[{key:"name",placeholder:"Nome completo"},{key:"relation",placeholder:"Relação (ex: Filho, Médico)"},{key:"phone",placeholder:"Telefone"}].map(f => (
                <input key={f.key} type="text" placeholder={f.placeholder}
                  value={newContact[f.key as keyof typeof newContact]}
                  onChange={e => setNewContact(p => ({...p,[f.key]:e.target.value}))}
                  className="w-full rounded-lg px-3 py-2.5 text-sm text-white/65 placeholder-white/18 outline-none border border-white/[0.07] focus:border-[#00D4A8]/40 transition-colors"
                  style={{background:"#0E1525"}}/>
              ))}
              <div className="flex gap-2 mt-1">
                <button onClick={addContact} className="flex-1 py-2 rounded-lg text-sm font-semibold"
                  style={{background:"#00D4A81E",color:"#00D4A8"}}>Salvar</button>
                <button onClick={() => {setShowForm(false); setNewContact({name:"",relation:"",phone:""});}}
                  className="flex-1 py-2 rounded-lg text-sm font-semibold text-white/28"
                  style={{background:"rgba(255,255,255,0.04)"}}>Cancelar</button>
              </div>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowForm(true)}
            className="w-full mt-2 py-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 border border-dashed border-white/10 text-white/25 hover:text-white/40 transition-all">
            <UserPlus size={12}/> Adicionar Contato
          </button>
        )}
      </div>
      <div className="rounded-xl border border-[#FF4B6E]/15 p-4" style={{background:"#FF4B6E07"}}>
        <div className="text-[9px] font-bold tracking-[0.15em] uppercase text-[#FF4B6E]/50 mb-3">Linhas de Emergência</div>
        {[
          {label:"SAMU",number:"192",desc:"Urgência médica"},
          {label:"Bombeiros",number:"193",desc:"Resgate e socorro"},
          {label:"CVV",number:"188",desc:"Apoio emocional"},
          {label:"Defesa Civil",number:"199",desc:"Emergências gerais"},
        ].map(l => (
          <div key={l.label} className="flex items-center justify-between py-2 border-b border-white/[0.04] last:border-0">
            <div>
              <span className="text-white/55 text-sm font-semibold">{l.label}</span>
              <span className="text-white/22 text-xs ml-2">{l.desc}</span>
            </div>
            <span className="font-bold text-base tabular-nums" style={{color:"#FF4B6E",fontFamily:"'JetBrains Mono', monospace"}}>{l.number}</span>
          </div>
        ))}
      </div>
    </>
  );

  // ── Motion sensor props shorthand
  const sensorProps = {
    state: motionState,
    secondsAgo: secondsSinceAct,
    accelGranted,
    onEnableAccel: enableAccelerometer,
    countdown,
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{background:"#080D18",fontFamily:"Barlow, sans-serif"}}>

      {/* Countdown overlay */}
      {countdown !== null && <CountdownOverlay countdown={countdown} onConfirm={confirmAlive}/>}

      {/* SOS banner */}
      {sosTriggered && <SOSBanner contacts={contacts} onDismiss={() => { sosRef.current=false; setSosTriggered(false); }}/>}

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header
        className="shrink-0 px-4 py-3 border-b border-white/[0.05] flex items-center gap-3"
        style={{background:"#060B15", marginTop: sosTriggered ? "52px" : 0}}
      >
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{background:"#00D4A8"}}>
            <Heart size={13} className="text-black" fill="black"/>
          </div>
          <span className="text-white font-semibold text-sm hidden sm:block" style={{fontFamily:"'DM Serif Display', serif"}}>
            CardioWatch
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-white/80 text-sm font-semibold truncate">João Carlos Pereira</span>
            <span className="text-xs px-2 py-0.5 rounded-full font-semibold shrink-0"
              style={{background:`${COLOR[overall]}18`,color:COLOR[overall]}}>
              {LABEL[overall]}
            </span>
          </div>
          <div className="text-white/28 text-[10px]">68 anos · Monitoramento domiciliar</div>
        </div>

        {/* Motion status (compact) */}
        <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border shrink-0"
          style={{
            background: motionState==="active"?"#00D4A808":motionState==="idle"?"#F5A62308":"#FF4B6E10",
            borderColor: motionState==="active"?"#00D4A822":motionState==="idle"?"#F5A62322":"#FF4B6E30",
          }}>
          <div className={`w-1.5 h-1.5 rounded-full ${motionState==="active"?"animate-pulse":""}`}
            style={{background: motionState==="active"?"#00D4A8":motionState==="idle"?"#F5A623":"#FF4B6E"}}/>
          <span className="text-[10px] font-semibold"
            style={{color: motionState==="active"?"#00D4A8":motionState==="idle"?"#F5A623":"#FF4B6E"}}>
            {motionState==="active"?"Ativo":motionState==="idle"?`${secondsSinceAct}s sem mov.`:"Sem resposta"}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <LiveClock className="text-white/30 text-xs"/>
          <button onClick={toggleSim}
            className="text-[10px] px-2.5 py-1.5 rounded-lg font-semibold border transition-all"
            style={simMode==="alerta"
              ?{background:"#FF4B6E18",borderColor:"#FF4B6E35",color:"#FF4B6E"}
              :{background:"rgba(255,255,255,0.04)",borderColor:"rgba(255,255,255,0.08)",color:"rgba(255,255,255,0.3)"}}>
            {simMode==="alerta"?"⚡ Ativo":"Simular"}
          </button>
        </div>
      </header>

      {/* ── DESKTOP layout (md+) ────────────────────────────────────────────── */}
      <div className="hidden md:flex flex-1 overflow-hidden">
        {/* Left */}
        <div className="flex-1 min-w-0 flex flex-col overflow-y-auto p-4 gap-4">
          {/* Sensor card */}
          <MotionSensorCard {...sensorProps}/>

          {/* ECG */}
          <div className="rounded-xl border border-white/[0.05] overflow-hidden shrink-0" style={{background:"#0E1525"}}>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.05]">
              <div className="flex items-center gap-2">
                <Activity size={13} style={{color:COLOR[hrSt(hrR)]}}/>
                <span className="text-white/50 text-xs font-semibold tracking-wide">ECG em Tempo Real — Derivação II</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{background:COLOR[overall]}}/>
                <span className="text-[10px] font-mono text-white/25">25 mm/s · {hrR} bpm</span>
              </div>
            </div>
            <div className="h-[160px]">
              <iframe src={THINGSPEAK_URL} className="w-full h-full border-0" title="ECG em Tempo Real" loading="lazy"/>
            </div>
          </div>

          <VitalCards/>
          {isDesktop && <TrendChart height={130} hrR={hrR} rrR={rrR} temp={temp} chartTab={chartTab} setChartTab={setChartTab} history={history} cc={cc}/>}
          <EventsLog/>
        </div>

        {/* Right */}
        <div className="w-[300px] shrink-0 border-l border-white/[0.05] flex flex-col overflow-y-auto p-4 gap-4"
          style={{background:"#060B15"}}>
          <RecsPanel/>
          <ContactsPanel/>
        </div>
      </div>

      {/* ── MOBILE layout (< md) ────────────────────────────────────────────── */}
      <div className="flex md:hidden flex-1 overflow-hidden flex-col">
        {/* Critical banner */}
        {overall === "critical" && countdown === null && (
          <div className="shrink-0 px-4 py-2 flex items-center gap-2 border-b border-[#FF4B6E]/25"
            style={{background:"#FF4B6E0D"}}>
            <AlertTriangle size={12} className="text-[#FF4B6E] animate-pulse"/>
            <span className="text-[#FF4B6E] text-xs font-semibold flex-1">Irregularidade crítica detectada</span>
            <button onClick={() => setMobileTab("contatos")}
              className="text-[10px] px-2 py-1 rounded font-bold"
              style={{background:"#FF4B6E20",color:"#FF4B6E"}}>Avisar</button>
          </div>
        )}

        {/* Dormant warning (mobile) */}
        {motionState === "dormant" && countdown === null && (
          <div className="shrink-0 px-4 py-2 flex items-center gap-2 border-b border-[#F5A623]/25"
            style={{background:"#F5A62308"}}>
            <WifiOff size={12} className="text-[#F5A623]"/>
            <span className="text-[#F5A623] text-xs font-semibold flex-1">
              Sem movimento há {secondsSinceAct}s — toque a tela para confirmar presença
            </span>
          </div>
        )}

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto" style={{paddingBottom:"72px"}}>

          {mobileTab === "sinais" && (
            <div className="p-3 flex flex-col gap-3">
              {/* Sensor card (prominent on mobile) */}
              <MotionSensorCard {...sensorProps}/>

              {/* ECG */}
              <div className="rounded-xl border border-white/[0.05] overflow-hidden" style={{background:"#0E1525"}}>
                <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.05]">
                  <div className="flex items-center gap-1.5">
                    <Activity size={12} style={{color:COLOR[hrSt(hrR)]}}/>
                    <span className="text-white/45 text-[11px] font-semibold">ECG em Tempo Real</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{background:COLOR[overall]}}/>
                    <span className="text-[9px] font-mono text-white/22">{hrR} bpm</span>
                  </div>
                </div>
                <div className="h-[140px]">
                  <iframe src={THINGSPEAK_URL} className="w-full h-full border-0" title="ECG em Tempo Real" loading="lazy"/>
                </div>
              </div>

              <VitalCards compact/>
              {!isDesktop && <TrendChart height={160} hrR={hrR} rrR={rrR} temp={temp} chartTab={chartTab} setChartTab={setChartTab} history={history} cc={cc}/>}
            </div>
          )}

          {mobileTab === "alertas" && (
            <div className="p-3"><EventsLog/></div>
          )}

          {mobileTab === "saude" && (
            <div className="p-3"><RecsPanel/></div>
          )}

          {mobileTab === "contatos" && (
            <div className="p-3 flex flex-col gap-3"><ContactsPanel/></div>
          )}
        </div>

        {/* Bottom tabs */}
        <nav
          className="fixed bottom-0 left-0 right-0 border-t border-white/[0.07] flex items-stretch"
          style={{background:"#060B15", height:"60px", zIndex:40}}
        >
          {([
            { id:"sinais"   as MobileTab, label:"Sinais",    Icon:LayoutDashboard, badge:0          },
            { id:"alertas"  as MobileTab, label:"Alertas",   Icon:AlertTriangle,   badge:critCount  },
            { id:"saude"    as MobileTab, label:"Saúde",     Icon:Stethoscope,     badge:0          },
            { id:"contatos" as MobileTab, label:"Contatos",  Icon:Phone,           badge:0          },
          ] as const).map(tab => {
            const active = mobileTab === tab.id;
            const tabColor = active ? COLOR[overall] : "rgba(255,255,255,0.3)";
            return (
              <button key={tab.id} onClick={() => setMobileTab(tab.id)}
                className="flex-1 flex flex-col items-center justify-center gap-0.5 relative transition-colors">
                {active && (
                  <div className="absolute top-0 left-4 right-4 h-[2px] rounded-full"
                    style={{background: COLOR[overall]}}/>
                )}
                <div className="relative">
                  <tab.Icon size={18} style={{color: tabColor}}/>
                  {tab.badge > 0 && (
                    <span className="absolute -top-1 -right-2 w-4 h-4 rounded-full text-[8px] font-bold flex items-center justify-center"
                      style={{background:"#FF4B6E",color:"white"}}>
                      {tab.badge > 9 ? "9+" : tab.badge}
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-semibold" style={{color: tabColor}}>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
