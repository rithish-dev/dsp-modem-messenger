import React, { useState, useRef, useEffect, useCallback } from "react";

// --- FSK-ish encoding parameters (loosely modeled on Bell 202 style AFSK) ---
const MARK_FREQ = 1200; // '1' bit
const SPACE_FREQ = 2200; // '0' bit
const BAUD = 300; // bits per second (slow on purpose)
const SAMPLE_RATE = 44100;

function textToBits(text) {
  const bytes = new TextEncoder().encode(text);
  let bits = [];
  for (const b of bytes) {
    // start bit
    bits.push(0);
    for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
    // stop bit
    bits.push(1);
  }
  return bits;
}

function synthesizeFSK(bits, snr) {
  const samplesPerBit = Math.floor(SAMPLE_RATE / BAUD);
  const totalSamples = bits.length * samplesPerBit;
  const buffer = new Float32Array(totalSamples);
  let phase = 0;
  const noiseAmp = Math.max(0, 1 - snr) * 0.35;

  for (let i = 0; i < bits.length; i++) {
    const freq = bits[i] === 1 ? MARK_FREQ : SPACE_FREQ;
    const dPhase = (2 * Math.PI * freq) / SAMPLE_RATE;
    for (let s = 0; s < samplesPerBit; s++) {
      const idx = i * samplesPerBit + s;
      phase += dPhase;
      let sample = Math.sin(phase) * 0.6;
      sample += (Math.random() * 2 - 1) * noiseAmp;
      buffer[idx] = sample;
    }
  }
  return buffer;
}

function corruptText(text, snr) {
  // Lower SNR = more characters get mangled and "reconstructed" (shown struck through)
  const corruptionChance = Math.max(0, (1 - snr) * 0.4);
  const chars = text.split("");
  const corrupted = [];
  for (const c of chars) {
    if (c !== " " && Math.random() < corruptionChance) {
      corrupted.push({ char: c, glitched: true });
    } else {
      corrupted.push({ char: c, glitched: false });
    }
  }
  return corrupted;
}

function useAudioContext() {
  const ctxRef = useRef(null);
  const get = () => {
    if (!ctxRef.current) {
      ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    return ctxRef.current;
  };
  return get;
}

function playBuffer(ctx, floatData, onEnd) {
  const buffer = ctx.createBuffer(1, floatData.length, SAMPLE_RATE);
  buffer.copyToChannel(floatData, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;

  source.connect(analyser);
  analyser.connect(ctx.destination);
  source.onended = onEnd;
  source.start();
  return { source, analyser };
}

function Spectrogram({ analyser, active }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const columnRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    ctx2d.fillStyle = "#03110a";
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    columnRef.current = 0;
  }, [active]);

  useEffect(() => {
    if (!analyser || !active) return;
    const canvas = canvasRef.current;
    const ctx2d = canvas.getContext("2d");
    const bufferLength = analyser.frequencyBinCount;
    const data = new Uint8Array(bufferLength);

    const draw = () => {
      analyser.getByteFrequencyData(data);
      const x = columnRef.current % canvas.width;

      for (let y = 0; y < canvas.height; y++) {
        const bin = Math.floor((y / canvas.height) * bufferLength * 0.5);
        const v = data[bufferLength - 1 - bin] || 0;
        const intensity = v / 255;
        // phosphor green terminal palette
        const r = Math.floor(10 + intensity * 40);
        const g = Math.floor(40 + intensity * 200);
        const b = Math.floor(30 + intensity * 60);
        ctx2d.fillStyle = `rgb(${r},${g},${b})`;
        ctx2d.fillRect(x, canvas.height - y, 1, 1);
      }

      columnRef.current += 1;
      if (columnRef.current % canvas.width === 0) {
        ctx2d.fillStyle = "#03110a";
        ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      }

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [analyser, active]);

  return (
    <canvas
      ref={canvasRef}
      width={480}
      height={110}
      className="w-full h-full"
      style={{ imageRendering: "pixelated" }}
    />
  );
}

const SAMPLE_LOG = [
  { from: "you", text: "testing the line, do you read", status: "delivered" },
  { from: "peer", text: "loud and clear. slow as hell though", status: "delivered" },
];

export default function ModemApp() {
  const getCtx = useAudioContext();
  const [input, setInput] = useState("");
  const [log, setLog] = useState(SAMPLE_LOG);
  const [status, setStatus] = useState("idle"); // idle | transmitting | failed
  const [snr, setSnr] = useState(0.8);
  const [analyser, setAnalyser] = useState(null);
  const [progress, setProgress] = useState(0);
  const [etaMs, setEtaMs] = useState(0);
  const timerRef = useRef(null);
  const logEndRef = useRef(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log, status]);

  const rollChannel = () => {
    // channel quality drifts each transmission, occasionally rough
    const roll = Math.random();
    let newSnr;
    if (roll < 0.12) newSnr = 0.15 + Math.random() * 0.15; // rough
    else if (roll < 0.35) newSnr = 0.4 + Math.random() * 0.25; // fair
    else newSnr = 0.7 + Math.random() * 0.3; // clean
    return newSnr;
  };

  const send = useCallback(() => {
    if (!input.trim() || status === "transmitting") return;
    const message = input.trim();
    const channelSnr = rollChannel();
    setSnr(channelSnr);
    setInput("");
    setStatus("transmitting");
    setProgress(0);

    const ctx = getCtx();
    if (ctx.state === "suspended") ctx.resume();

    const bits = textToBits(message);
    const floatData = synthesizeFSK(bits, channelSnr);
    const durationMs = (floatData.length / SAMPLE_RATE) * 1000;
    setEtaMs(durationMs);

    const carrierLost = Math.random() < 0.06; // ~6% chance the line just drops

    const startTime = performance.now();
    const tick = () => {
      const elapsed = performance.now() - startTime;
      const pct = Math.min(100, (elapsed / durationMs) * 100);
      setProgress(pct);
      if (pct < 100) {
        timerRef.current = requestAnimationFrame(tick);
      }
    };
    timerRef.current = requestAnimationFrame(tick);

    if (carrierLost) {
      // cut audio short, mark as failed
      const cutoff = new Float32Array(floatData.slice(0, Math.floor(floatData.length * (0.2 + Math.random() * 0.4))));
      const { analyser: a } = playBuffer(ctx, cutoff, () => {
        cancelAnimationFrame(timerRef.current);
        setStatus("failed");
        setLog((prev) => [
          ...prev,
          { from: "you", text: message, status: "lost", corrupted: corruptText(message, 0.1) },
        ]);
        setTimeout(() => setStatus("idle"), 1800);
      });
      setAnalyser(a);
    } else {
      const { analyser: a } = playBuffer(ctx, floatData, () => {
        cancelAnimationFrame(timerRef.current);
        setProgress(100);
        setStatus("idle");
        setLog((prev) => [
          ...prev,
          {
            from: "you",
            text: message,
            status: "delivered",
            corrupted: channelSnr < 0.55 ? corruptText(message, channelSnr) : null,
          },
        ]);
      });
      setAnalyser(a);
    }
  }, [input, status, getCtx]);

  const channelLabel =
    snr > 0.7 ? "CLEAR" : snr > 0.4 ? "FAIR" : "NOISY";
  const channelColor =
    snr > 0.7 ? "#4ade80" : snr > 0.4 ? "#facc15" : "#f87171";

  return (
    <div
      className="min-h-screen w-full flex items-center justify-center p-4"
      style={{ background: "#020604", fontFamily: "'IBM Plex Mono', 'Courier New', monospace" }}
    >
      <div
        className="w-full max-w-md rounded-md overflow-hidden border"
        style={{ borderColor: "#123322", background: "#06120c", boxShadow: "0 0 40px rgba(74,222,128,0.08)" }}
      >
        {/* Header / status bar */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b"
          style={{ borderColor: "#123322", background: "#081a10" }}
        >
          <div className="flex items-center gap-2">
            <div
              className="w-2 h-2 rounded-full"
              style={{ background: status === "transmitting" ? "#facc15" : "#4ade80" }}
            />
            <span style={{ color: "#c9f7dd", fontSize: 13, letterSpacing: 1 }}>MODEM</span>
          </div>
          <div style={{ fontSize: 11, color: channelColor, letterSpacing: 1 }}>
            LINE: {channelLabel} · {BAUD} BAUD
          </div>
        </div>

        {/* Spectrogram */}
        <div style={{ height: 110, background: "#03110a" }}>
          <Spectrogram analyser={analyser} active={status === "transmitting"} />
        </div>

        {/* Transmission progress */}
        {status === "transmitting" && (
          <div className="px-4 py-2" style={{ background: "#081a10", borderTop: "1px solid #123322" }}>
            <div style={{ fontSize: 11, color: "#8fd6ab", marginBottom: 4 }}>
              TRANSMITTING · {(etaMs / 1000).toFixed(1)}s @ {Math.round(snr * 100)}% SNR
            </div>
            <div style={{ height: 4, background: "#0e2417", borderRadius: 2, overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${progress}%`,
                  background: "#4ade80",
                  transition: "width 0.05s linear",
                }}
              />
            </div>
          </div>
        )}
        {status === "failed" && (
          <div
            className="px-4 py-2 text-center"
            style={{ background: "#2a0e0e", color: "#f87171", fontSize: 12, letterSpacing: 1 }}
          >
            CARRIER LOST — MESSAGE NOT DELIVERED
          </div>
        )}

        {/* Message log */}
        <div
          className="px-4 py-3 space-y-3 overflow-y-auto"
          style={{ height: 260, background: "#050f0a" }}
        >
          {log.map((m, i) => (
            <div key={i} className={`flex ${m.from === "you" ? "justify-end" : "justify-start"}`}>
              <div
                className="max-w-[80%] px-3 py-2 rounded"
                style={{
                  background: m.from === "you" ? "#123322" : "#0e1f16",
                  border: m.status === "lost" ? "1px solid #f87171" : "1px solid #1c3d28",
                }}
              >
                <div style={{ fontSize: 13, color: "#e2fbe9", lineHeight: 1.4 }}>
                  {m.corrupted
                    ? m.corrupted.map((c, j) =>
                        c.glitched ? (
                          <span key={j} style={{ color: "#f87171", textDecoration: "line-through" }}>
                            {c.char}
                          </span>
                        ) : (
                          <span key={j}>{c.char}</span>
                        )
                      )
                    : m.text}
                </div>
                <div
                  style={{
                    fontSize: 9,
                    marginTop: 4,
                    color: m.status === "lost" ? "#f87171" : "#5f9c78",
                    letterSpacing: 0.5,
                  }}
                >
                  {m.status === "lost" ? "LOST IN TRANSIT" : m.status === "delivered" ? "DELIVERED" : ""}
                </div>
              </div>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>

        {/* Input */}
        <div className="flex items-center gap-2 px-3 py-3 border-t" style={{ borderColor: "#123322", background: "#081a10" }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="type transmission..."
            disabled={status === "transmitting"}
            className="flex-1 px-3 py-2 rounded outline-none"
            style={{
              background: "#050f0a",
              border: "1px solid #1c3d28",
              color: "#e2fbe9",
              fontSize: 13,
              fontFamily: "inherit",
            }}
          />
          <button
            onClick={send}
            disabled={status === "transmitting" || !input.trim()}
            className="px-4 py-2 rounded"
            style={{
              background: status === "transmitting" ? "#123322" : "#4ade80",
              color: status === "transmitting" ? "#5f9c78" : "#03110a",
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: 1,
              cursor: status === "transmitting" ? "default" : "pointer",
              border: "none",
            }}
          >
            SEND
          </button>
        </div>
      </div>
    </div>
  );
}
