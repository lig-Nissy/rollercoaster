'use client';

import { useEffect, useRef } from 'react';
import { BODY_LIMITS, RESTRAINTS, WHEEL_LIMITS, type CoasterSim, type Restraint } from './simEngine';

const Z_MIN = -4;
const Z_MAX = 7.5;

/**
 * 上下 G の縦型メーター。投げ出し・意識喪失・脱線の限界線を目盛りに直接描く。
 * 針が線を越えると何が起きるかが一目でわかるようにする。
 */
export function VerticalGauge({ gz, peakMin, peakMax, restraint }: { gz: number; peakMin: number; peakMax: number; restraint: Restraint }) {
  const H = 260;
  const y = (g: number) => ((Z_MAX - Math.max(Z_MIN, Math.min(Z_MAX, g))) / (Z_MAX - Z_MIN)) * H;
  const R = RESTRAINTS[restraint];
  const lines: { g: number; label: string; color: string }[] = [
    { g: WHEEL_LIMITS.gzMax, label: '脱線', color: '#e5484d' },
    { g: BODY_LIMITS.glocGz, label: '意識を失う', color: '#ffc93c' },
    { g: R.gzMin, label: '投げ出される', color: '#e5484d' },
    { g: WHEEL_LIMITS.gzMin, label: '脱線', color: '#e5484d' },
  ];
  // ラベルが重ならないよう、上から順に 17px 以上あける
  const labelY: number[] = [];
  lines.forEach((l, i) => {
    const want = y(l.g);
    labelY.push(i > 0 ? Math.max(want, labelY[i - 1] + 17) : want);
  });
  const danger = gz > BODY_LIMITS.glocGz || gz < R.gzMin + 0.3;
  return (
    <svg width="132" height={H + 30} viewBox={`0 -10 132 ${H + 30}`} aria-label={`上下G ${gz.toFixed(1)}`}>
      <rect x="0" y="0" width="14" height={H} rx="7" fill="rgba(23,52,81,0.75)" />
      {/* 安全基準の範囲（-0.5〜4.0G） */}
      <rect x="2" y={y(4)} width="10" height={y(-0.5) - y(4)} rx="5" fill="rgba(47,163,107,0.55)" />
      {[0, 1, 2, 3, 4, 5, 6, 7, -1, -2, -3, -4].map((g) => (
        <line key={g} x1="0" x2="5" y1={y(g)} y2={y(g)} stroke="#cfe0ee" strokeWidth={g === 0 || g === 1 ? 1.2 : 0.6} />
      ))}
      <text x="-2" y={y(1) + 3} fontSize="9" fill="#cfe0ee" textAnchor="end">1</text>
      {lines.map((l, i) => (
        <g key={i}>
          <line x1="0" x2="20" y1={y(l.g)} y2={y(l.g)} stroke={l.color} strokeWidth="2" />
          {labelY[i] !== y(l.g) && <line x1="20" x2="24" y1={y(l.g)} y2={labelY[i]} stroke={l.color} strokeWidth="1" />}
          <rect x="24" y={labelY[i] - 8} width="96" height="16" rx="3" fill="rgba(13,27,40,0.72)" />
          <text x="29" y={labelY[i] + 4} fontSize="11" fill={l.color}>
            {l.label} {l.g > 0 ? '+' : ''}
            {l.g}
          </text>
        </g>
      ))}
      {/* これまでの最大・最小 */}
      <line x1="0" x2="14" y1={y(peakMax)} y2={y(peakMax)} stroke="#ffffff" strokeOpacity="0.5" strokeDasharray="2 2" />
      <line x1="0" x2="14" y1={y(peakMin)} y2={y(peakMin)} stroke="#ffffff" strokeOpacity="0.5" strokeDasharray="2 2" />
      {/* 現在値 */}
      <polygon
        points={`14,${y(gz)} 22,${y(gz) - 6} 22,${y(gz) + 6}`}
        fill={danger ? '#e5484d' : '#ffffff'}
        style={{ transition: 'all 90ms linear' }}
      />
    </svg>
  );
}

/** 横 G の横型メーター */
export function LateralGauge({ gy, restraint }: { gy: number; restraint: Restraint }) {
  const W = 240;
  const MAX = 3.5;
  const x = (g: number) => ((Math.max(-MAX, Math.min(MAX, g)) + MAX) / (2 * MAX)) * W;
  const R = RESTRAINTS[restraint];
  return (
    <svg width={W + 20} height="44" viewBox={`-10 0 ${W + 20} 44`} aria-label={`横G ${gy.toFixed(1)}`}>
      <rect x="0" y="14" width={W} height="10" rx="5" fill="rgba(23,52,81,0.75)" />
      <rect x={x(-0.3)} y="16" width={x(0.3) - x(-0.3)} height="6" rx="3" fill="rgba(47,163,107,0.6)" />
      {[-R.gyAbs, R.gyAbs].map((g) => (
        <line key={g} x1={x(g)} x2={x(g)} y1="10" y2="28" stroke="#e5484d" strokeWidth="2" />
      ))}
      {[-WHEEL_LIMITS.gyAbs, WHEEL_LIMITS.gyAbs].map((g) => (
        <line key={`w${g}`} x1={x(g)} x2={x(g)} y1="12" y2="26" stroke="#e5484d" strokeWidth="1" strokeDasharray="2 2" />
      ))}
      <line x1={x(0)} x2={x(0)} y1="12" y2="26" stroke="#cfe0ee" />
      <circle cx={x(gy)} cy="19" r="6" fill={Math.abs(gy) > R.gyAbs - 0.2 ? '#e5484d' : '#ffffff'} style={{ transition: 'all 90ms linear' }} />
      <text x={x(-R.gyAbs)} y="40" fontSize="10" fill="#ffb3b5" textAnchor="middle">投げ出される</text>
      <text x={x(R.gyAbs)} y="40" fontSize="10" fill="#ffb3b5" textAnchor="middle">投げ出される</text>
      <text x={x(0)} y="8" fontSize="10" fill="#cfe0ee" textAnchor="middle">横G {gy.toFixed(1)}</text>
    </svg>
  );
}

/** 直近 20 秒の上下 G・横 G のグラフ（シミュレーターの記録を直接読む） */
export function TelemetryChart({ simRef, restraint }: { simRef: React.RefObject<CoasterSim | null>; restraint: Restraint }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const c = canvasRef.current;
      const sim = simRef.current;
      if (!c || !sim) return;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== w * dpr) {
        c.width = w * dpr;
        c.height = h * dpr;
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const gMin = -4;
      const gMax = 7;
      const y = (g: number) => h - ((Math.max(gMin, Math.min(gMax, g)) - gMin) / (gMax - gMin)) * h;
      const data = sim.telemetry;
      const tEnd = data.length ? data[data.length - 1].t : 0;
      const x = (t: number) => w - ((tEnd - t) / 20) * w;

      ctx.lineWidth = 1;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textBaseline = 'bottom';
      ctx.strokeStyle = '#d5dde4';
      ctx.fillStyle = '#7a8996';
      for (const g of [0, 1, 4]) {
        ctx.beginPath();
        ctx.moveTo(0, y(g));
        ctx.lineTo(w, y(g));
        ctx.stroke();
        ctx.fillText(`${g}G`, 4, y(g) - 1);
      }
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#e5484d';
      ctx.fillStyle = '#c0353a';
      for (const [g, label] of [
        [RESTRAINTS[restraint].gzMin, '投げ出し'],
        [WHEEL_LIMITS.gzMax, '脱線'],
      ] as [number, string][]) {
        ctx.beginPath();
        ctx.moveTo(0, y(g));
        ctx.lineTo(w, y(g));
        ctx.stroke();
        ctx.fillText(`${label} ${g}G`, w - 74, y(g) - 1);
      }
      ctx.setLineDash([]);

      // 横G
      ctx.strokeStyle = '#d08a00';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      data.forEach((d, i) => {
        const px = x(d.t);
        const py = y(d.gy);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      // 左の席の上下G
      ctx.strokeStyle = '#1d5b93';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      data.forEach((d, i) => {
        const px = x(d.t);
        const py = y(d.gzLeft ?? d.gz);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      // 右の席の上下G（破線）
      ctx.strokeStyle = '#6aaed6';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      data.forEach((d, i) => {
        const px = x(d.t);
        const py = y(d.gzRight ?? d.gz);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }, 100);
    return () => clearInterval(id);
  }, [simRef, restraint]);

  return (
    <figure className="m-0">
      <canvas ref={canvasRef} className="w-full h-36 rounded-md bg-white border border-[#d5dde4]" aria-label="直近20秒のGの推移" />
      <figcaption className="mt-1.5 flex flex-wrap gap-3 text-xs text-[#4a5a68]">
        <span><span className="inline-block w-3 h-0.5 align-middle bg-[#1d5b93] mr-1" />上下G（左）</span>
        <span><span className="inline-block w-3 h-px align-middle border-t-2 border-dashed border-[#6aaed6] mr-1" />上下G（右）</span>
        <span><span className="inline-block w-3 h-0.5 align-middle bg-[#d08a00] mr-1" />横G</span>
        <span><span className="inline-block w-3 border-t border-dashed border-[#e5484d] align-middle mr-1" />限界（投げ出し・脱線）</span>
      </figcaption>
    </figure>
  );
}
