/**
 * コースが安全基準（このプロジェクトの設計目標）を満たすかを走行シミュレーションで判定する
 *
 *   npx tsx scripts/validateCourse.ts
 *
 * 判定基準
 *   上下 G : -0.5 〜 +4.0 G   … ASTM F2291 の目安（短時間 +5〜6 G / -2 G）より十分内側
 *   横 G   : ±0.3 G 未満      … 国交省：横方向 3 m/s² 以上は横滑り対策が必要
 *   前後 G : ±1.0 G 以内      … 巻き上げで背もたれに寄りかかる分も含む
 *   重力だけで走る区間で止まらない（摩擦・空気抵抗 1.5 倍の悪条件でも）
 *   レールが地面より 0.5m 以上高い
 *   線路どうしが交差・重なる所は 4m 以上離れている（車両と乗客が通る空間）
 *   G は ASTM F2291 にならい 5Hz ローパスを掛けた値で評価する
 */
import { buildTrack, COURSE } from '../src/components/coasterTrack';
import { bankForDesignSpeed, createPhysics, DEFAULT_PHYSICS, type PhysicsParams } from '../src/components/coasterPhysics';

const LIMITS = { gzMax: 4.0, gzMin: -0.5, gyAbs: 0.3, gxAbs: 1.0, minHeight: 0.5, clearance: 4.0 };
const DT = 1 / 120;

function lowPass(values: number[], dt: number, cutoffHz = 5) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const k = dt / (rc + dt);
  const fwd = [...values];
  for (let i = 1; i < fwd.length; i++) fwd[i] = fwd[i - 1] + k * (values[i] - fwd[i - 1]);
  const out = [...fwd];
  for (let i = out.length - 2; i >= 0; i--) out[i] = out[i + 1] + k * (fwd[i] - out[i + 1]);
  return out;
}

/** 線路上で 20m 以上離れた2点の、空間上の最短距離 */
function minClearance(track: ReturnType<typeof buildTrack>) {
  const p = track.samples;
  const skip = Math.round(20 / track.sampleStep);
  let best = { d: Infinity, s1: 0, s2: 0 };
  for (let i = 0; i < p.length; i += 2) {
    for (let j = i + skip; j < p.length - (skip - i > 0 ? skip - i : 0); j += 2) {
      const d = p[i].pos.distanceTo(p[j].pos);
      if (d < best.d) best = { d, s1: p[i].s, s2: p[j].s };
    }
  }
  return best;
}

function run(label: string, params: Partial<PhysicsParams>) {
  const track = buildTrack(COURSE);
  bankForDesignSpeed(track); // バンクは標準条件で決めて固定

  const ph = createPhysics(track, params);
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

  const gz = lowPass(rec.map((r) => r.gz), DT);
  const gy = lowPass(rec.map((r) => r.gy), DT);
  const gx = lowPass(rec.map((r) => r.gx), DT);
  const absMax = (a: number[]) => Math.max(...a.map(Math.abs));
  const minY = Math.min(...track.samples.map((p) => p.pos.y));
  const stalls = rec.filter((r) => r.stalled).length;
  const gap = minClearance(track);

  const checks = {
    '一周できる': laps >= 2 && stalls === 0,
    [`上下G ${Math.min(...gz).toFixed(2)} 〜 ${Math.max(...gz).toFixed(2)}`]:
      Math.max(...gz) <= LIMITS.gzMax && Math.min(...gz) >= LIMITS.gzMin,
    [`横G 最大 ${absMax(gy).toFixed(2)}`]: absMax(gy) < LIMITS.gyAbs,
    [`前後G 最大 ${absMax(gx).toFixed(2)}`]: absMax(gx) <= LIMITS.gxAbs,
    [`最低高さ ${minY.toFixed(1)}m`]: minY >= LIMITS.minHeight,
    [`線路どうしの最短距離 ${gap.d.toFixed(1)}m（${gap.s1.toFixed(0)}m 地点と ${gap.s2.toFixed(0)}m 地点）`]:
      gap.d >= LIMITS.clearance,
  };
  const ok = Object.values(checks).every(Boolean);

  console.log(`\n${ok ? '✅ PASS' : '❌ FAIL'}  ${label}`);
  console.log(
    `   全長 ${track.length.toFixed(0)}m / 1周 ${lapTime.toFixed(1)}秒 / 最高 ${(Math.max(...rec.map((r) => r.v)) * 3.6).toFixed(0)}km/h`,
  );
  for (const [name, pass] of Object.entries(checks)) console.log(`   ${pass ? '✓' : '✗'} ${name}`);
  return ok;
}

const results = [
  run('標準条件', {}),
  run('悪条件（摩擦・空気抵抗 ×1.5：寒い日・車輪の摩耗）', {
    rollingFriction: DEFAULT_PHYSICS.rollingFriction * 1.5,
    airDrag: DEFAULT_PHYSICS.airDrag * 1.5,
  }),
  run('好条件（摩擦・空気抵抗 ×0.5：暑い日・よく回る車輪）', {
    rollingFriction: DEFAULT_PHYSICS.rollingFriction * 0.5,
    airDrag: DEFAULT_PHYSICS.airDrag * 0.5,
  }),
];
process.exit(results.every(Boolean) ? 0 : 1);
