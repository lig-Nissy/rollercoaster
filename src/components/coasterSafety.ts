import { buildTrack, type CourseDesign, type Track } from './coasterTrack';
import { bankForDesignSpeed, createPhysics, DEFAULT_PHYSICS, type PhysicsParams } from './coasterPhysics';

/**
 * 安全基準（このプロジェクトの設計目標）
 *   上下 G : -0.5 〜 +4.0 G   … ASTM F2291 の目安（短時間 +5〜6 G / -2 G）より十分内側
 *   横 G   : ±0.3 G 未満      … 国交省：横方向 3 m/s² 以上は横滑り対策が必要
 *   前後 G : ±1.0 G 以内      … 巻き上げで背もたれに寄りかかる分も含む
 *   重力だけで走る区間で止まらない
 *   レールが地面より 0.5m 以上高い
 *   線路どうしが交差・重なる所は 4m 以上離れている
 *   G は ASTM F2291 にならい 5Hz ローパスを掛けた値で評価する
 */
export const SAFETY_LIMITS = { gzMax: 4.0, gzMin: -0.5, gyAbs: 0.3, gxAbs: 1.0, minHeight: 0.5, clearance: 4.0 };

export type SafetyCheck = { name: string; pass: boolean };
export type SafetyReport = {
  label: string;
  ok: boolean;
  length: number;
  lapTime: number;
  maxSpeed: number; // m/s
  checks: SafetyCheck[];
};

const DT = 1 / 120;

export function lowPass(values: number[], dt: number, cutoffHz = 5) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const k = dt / (rc + dt);
  const fwd = [...values];
  for (let i = 1; i < fwd.length; i++) fwd[i] = fwd[i - 1] + k * (values[i] - fwd[i - 1]);
  const out = [...fwd];
  for (let i = out.length - 2; i >= 0; i--) out[i] = out[i + 1] + k * (fwd[i] - out[i + 1]);
  return out;
}

/** 線路上で 20m 以上離れた2点の、空間上の最短距離 */
export function minClearance(track: Track) {
  const p = track.samples;
  const skip = Math.round(20 / track.sampleStep);
  let best = { d: Infinity, s1: 0, s2: 0 };
  for (let i = 0; i < p.length; i += 2) {
    const last = p.length - Math.max(0, skip - i);
    for (let j = i + skip; j < last; j += 2) {
      const d = p[i].pos.distanceTo(p[j].pos);
      if (d < best.d) best = { d, s1: p[i].s, s2: p[j].s };
    }
  }
  return best;
}

/** バンク済みの線路を、指定の条件で1周走らせて判定する */
export function evaluateTrack(track: Track, params: Partial<PhysicsParams>, label: string): SafetyReport {
  const ph = createPhysics(track, { ...params, allowRollback: false });
  const st = ph.createState();
  const rec: { v: number; gz: number; gy: number; gx: number; stalled: boolean }[] = [];
  let laps = 0;
  let prev = st.s;
  let lapStart = 0;
  let lapTime = 0;
  for (let k = 0, time = 0; k < 120 * 900 && laps < 2; k++, time += DT) {
    ph.step(st, DT);
    if (st.s < prev) {
      laps++;
      if (laps === 1) lapStart = time;
      if (laps === 2) lapTime = time - lapStart;
    }
    prev = st.s;
    if (laps === 1) rec.push({ v: st.v, gz: st.g.z, gy: st.g.y, gx: st.g.x, stalled: st.stalled });
  }

  const L = SAFETY_LIMITS;
  const gz = lowPass(rec.map((r) => r.gz), DT);
  const gy = lowPass(rec.map((r) => r.gy), DT);
  const gx = lowPass(rec.map((r) => r.gx), DT);
  const absMax = (a: number[]) => (a.length ? Math.max(...a.map(Math.abs)) : 0);
  const minY = Math.min(...track.samples.map((p) => p.pos.y));
  const stalls = rec.filter((r) => r.stalled).length;
  const gap = minClearance(track);
  const gzMin = gz.length ? Math.min(...gz) : 0;
  const gzMax = gz.length ? Math.max(...gz) : 0;

  const checks: SafetyCheck[] = [
    { name: '一周できる', pass: laps >= 2 && stalls === 0 },
    { name: `上下G ${gzMin.toFixed(2)} 〜 ${gzMax.toFixed(2)}`, pass: gzMax <= L.gzMax && gzMin >= L.gzMin },
    { name: `横G 最大 ${absMax(gy).toFixed(2)}`, pass: absMax(gy) < L.gyAbs },
    { name: `前後G 最大 ${absMax(gx).toFixed(2)}`, pass: absMax(gx) <= L.gxAbs },
    { name: `最低高さ ${minY.toFixed(1)}m`, pass: minY >= L.minHeight },
    {
      name: `線路どうしの最短距離 ${gap.d.toFixed(1)}m（${gap.s1.toFixed(0)}m 地点と ${gap.s2.toFixed(0)}m 地点）`,
      pass: gap.d >= L.clearance,
    },
  ];
  return {
    label,
    ok: checks.every((c) => c.pass),
    length: track.length,
    lapTime,
    maxSpeed: rec.length ? Math.max(...rec.map((r) => r.v)) : 0,
    checks,
  };
}

export const SAFETY_CONDITIONS: { label: string; scale: number }[] = [
  { label: '標準条件', scale: 1 },
  { label: '悪条件（摩擦・空気抵抗 ×1.5：寒い日・車輪の摩耗）', scale: 1.5 },
  { label: '好条件（摩擦・空気抵抗 ×0.5：暑い日・よく回る車輪）', scale: 0.5 },
];

/** 標準条件でバンクを付けた線路を3条件で走らせる */
export function evaluateCourse(design: CourseDesign, base: Partial<PhysicsParams> = {}): SafetyReport[] {
  const track = buildTrack(design);
  bankForDesignSpeed(track, base);
  return SAFETY_CONDITIONS.map(({ label, scale }) =>
    evaluateTrack(
      track,
      {
        ...base,
        rollingFriction: (base.rollingFriction ?? DEFAULT_PHYSICS.rollingFriction) * scale,
        airDrag: (base.airDrag ?? DEFAULT_PHYSICS.airDrag) * scale,
      },
      label,
    ),
  );
}
