import * as THREE from 'three';

/**
 * コース定義と線路データの生成
 *
 * 設計の流れ
 *   1. 平面形（上から見た形）をスーパー楕円で作る … 曲率が連続し、急に曲がり始めない
 *   2. 高さを「直線のスケッチ（キーフレーム）」で描き、ガウシアンで丸める
 *      … 勾配の折れ目が半径をもった曲線になり、上下 G の急変を防ぐ
 *   3. 速度プロファイルに合わせてバンク角を付ける … 横 G をほぼ 0 にする
 */

export type ZoneKind = 'station' | 'lift' | 'trim' | 'brake';
export type Zone = ZoneKind | 'free';

/** [u: 平面上の周回位置 0〜1, 高さ m, 丸めの強さ σ m] */
export type HeightKey = [u: number, h: number, sigma: number];

export type CourseDesign = {
  planA: number; // 平面スーパー楕円の半径 X [m]
  planB: number; // 平面スーパー楕円の半径 Z [m]
  planExp: number; // スーパー楕円の指数（2 = 楕円、大きいほど四角に近い）
  keys: HeightKey[];
  zones: { kind: ZoneKind; from: number; to: number }[]; // u の範囲
  controlPoints: number; // CatmullRom に渡す点の数
  maxBankDeg: number; // バンク角の上限
  bankSmoothing: number; // バンク角を平均する距離 [m]（ロール速度を抑える）
};

/**
 * レイアウトの考え方（u は上から見た周回位置。0 = 手前の辺の中央）
 *   u = 0, 0.25, 0.5, 0.75 … 辺の中央（ほぼ直線）
 *   u = 0.125, 0.375, 0.625, 0.875 … 角（カーブ）
 *
 *   ・浮遊感のある丘の頂上は直線に置く（上下 G が小さいとバンクで横 G を打ち消せないため）
 *   ・谷はカーブに置き、バンクを付ける（上下 G が大きいので傾けて横 G を打ち消せる）
 *   ・丘は後ろへ行くほど低くする（摩擦と空気抵抗でエネルギーが減る分の余裕）
 *   ・巻き上げの頂上はカーブ（遅いので横 G が出ない）
 */
export const COURSE: CourseDesign = {
  planA: 95,
  planB: 55,
  planExp: 4,
  keys: [
    [0.0, 2, 3], //     駅
    [0.005, 2, 3], //   巻き上げ開始
    [0.105, 33, 5], //  巻き上げ頂上
    [0.14, 33, 8], //   頂上（カーブしながら水平）
    [0.25, 3, 12], //   ファーストドロップの谷（直線）
    [0.375, 18, 12], // バンク付きの丘（カーブ）
    [0.44, 3, 10], //   谷
    [0.5, 17, 7], //    エアタイムの丘 1（直線）＋ トリムブレーキ
    [0.625, 3, 12], //  バンク付きの谷（カーブ）
    [0.75, 12, 7], //   エアタイムの丘 2（直線）
    [0.86, 3, 10], //   バンク付きの谷（カーブ）
    [0.875, 3, 6], //   ブレーキ区間
    [0.955, 2, 4], //   駅へ
  ],
  zones: [
    { kind: 'station', from: 0.955, to: 0.005 },
    { kind: 'lift', from: 0.005, to: 0.12 },
    { kind: 'trim', from: 0.49, to: 0.51 },
    { kind: 'brake', from: 0.875, to: 0.955 },
  ],
  controlPoints: 600,
  maxBankDeg: 75,
  bankSmoothing: 12,
};

// ---------------------------------------------------------------------------
// 1. 平面形
// ---------------------------------------------------------------------------

function buildPlan(d: CourseDesign) {
  const n = 4000;
  const raw: THREE.Vector2[] = [];
  const e = 2 / d.planExp;
  for (let i = 0; i < n; i++) {
    // a = -π/2 から開始すると、手前の長い辺を +X 方向へ走り出す
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    raw.push(
      new THREE.Vector2(
        d.planA * Math.sign(c) * Math.abs(c) ** e,
        d.planB * Math.sign(s) * Math.abs(s) ** e,
      ),
    );
  }
  const cum = [0];
  for (let i = 1; i <= n; i++) cum.push(cum[i - 1] + raw[i % n].distanceTo(raw[i - 1]));
  const length = cum[n];

  /** u（周長の割合）→ 平面座標 */
  function at(u: number) {
    const target = (((u % 1) + 1) % 1) * length;
    let lo = 0;
    let hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < target) lo = mid;
      else hi = mid;
    }
    const w = (target - cum[lo]) / (cum[lo + 1] - cum[lo] || 1);
    return raw[lo].clone().lerp(raw[(lo + 1) % n], w);
  }
  return { at, length };
}

// ---------------------------------------------------------------------------
// 2. 高さプロファイル（折れ線 → 可変幅ガウシアンで丸める）
// ---------------------------------------------------------------------------

function buildHeight(d: CourseDesign, planLength: number) {
  const n = Math.ceil(planLength); // 1m 間隔
  const keys = [...d.keys].sort((a, b) => a[0] - b[0]);
  const wrapKey = (k: number) => keys[((k % keys.length) + keys.length) % keys.length];

  function lin(u: number, idx: 1 | 2) {
    u = ((u % 1) + 1) % 1;
    for (let k = 0; k < keys.length; k++) {
      const a = keys[k];
      const b = wrapKey(k + 1);
      const ua = a[0];
      const ub = k + 1 === keys.length ? b[0] + 1 : b[0];
      if (u >= ua && u < ub) return a[idx] + ((b[idx] - a[idx]) * (u - ua)) / (ub - ua);
    }
    return keys[0][idx];
  }

  const sketch = Array.from({ length: n }, (_, i) => lin(i / n, 1));
  const smoothed = sketch.map((_, i) => {
    const sigma = lin(i / n, 2);
    const r = Math.ceil(sigma * 3);
    let sum = 0;
    let wsum = 0;
    for (let j = -r; j <= r; j++) {
      const w = Math.exp(-(j * j) / (2 * sigma * sigma));
      sum += w * sketch[(((i + j) % n) + n) % n];
      wsum += w;
    }
    return sum / wsum;
  });

  return (u: number) => {
    const x = (((u % 1) + 1) % 1) * n;
    const i = Math.floor(x);
    const w = x - i;
    return smoothed[i % n] * (1 - w) + smoothed[(i + 1) % n] * w;
  };
}

// ---------------------------------------------------------------------------
// 3. 線路データ（距離 s ごとのフレーム表）
// ---------------------------------------------------------------------------

export type TrackSample = {
  s: number; // 距離 [m]
  u: number; // 周回位置（ゾーン判定用）
  pos: THREE.Vector3;
  tan: THREE.Vector3; // 進行方向
  nor: THREE.Vector3; // バンク込みの「上」
  bin: THREE.Vector3; // バンク込みの「右」
  curv: THREE.Vector3; // 曲率ベクトル d²r/ds²（大きさ = 1/半径）
  bank: number; // バンク角 [rad]
};

export type Track = ReturnType<typeof buildTrack>;

export function buildTrack(d: CourseDesign = COURSE, sampleStep = 0.5) {
  const plan = buildPlan(d);
  const height = buildHeight(d, plan.length);

  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < d.controlPoints; i++) {
    const u = i / d.controlPoints;
    const p = plan.at(u);
    pts.push(new THREE.Vector3(p.x, height(u), p.y));
  }
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  curve.arcLengthDivisions = d.controlPoints * 8;
  curve.updateArcLengths();
  const length = curve.getLength();

  const count = Math.round(length / sampleStep);
  const ds = length / count;
  const samples: TrackSample[] = [];
  const up = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < count; i++) {
    const s = i * ds;
    const t = curve.getUtoTmapping(s / length, s);
    const pos = curve.getPoint(t);
    const tan = curve.getTangent(t).normalize();
    const nor = up.clone().addScaledVector(tan, -up.dot(tan)).normalize();
    const bin = new THREE.Vector3().crossVectors(tan, nor).normalize();
    samples.push({ s, u: t, pos, tan, nor, bin, curv: new THREE.Vector3(), bank: 0 });
  }
  // 曲率ベクトル：前後 2m の3点を通る円（外接円）から求める。
  // 単純な2階差分は点の間隔のわずかなムラで大きく振れるため使わない。
  const k = Math.max(1, Math.round(2 / ds));
  const ab = new THREE.Vector3();
  const cb = new THREE.Vector3();
  const ac = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const a = samples[(i - k + count) % count].pos;
    const b = samples[i].pos;
    const c = samples[(i + k) % count].pos;
    ab.subVectors(a, b);
    cb.subVectors(c, b);
    ac.subVectors(a, c);
    const area2 = new THREE.Vector3().crossVectors(ab, cb).length(); // 三角形の面積 × 2
    const kappa = (2 * area2) / (ab.length() * cb.length() * ac.length() || 1);
    const dir = ab.add(cb).multiplyScalar(0.5); // b から a・c の中点へ（曲がる内側）
    dir.addScaledVector(samples[i].tan, -dir.dot(samples[i].tan));
    samples[i].curv.copy(dir.lengthSq() > 1e-12 ? dir.normalize().multiplyScalar(kappa) : dir.set(0, 0, 0));
  }

  const zoneAtU = (u: number): Zone => {
    for (const z of d.zones) {
      const inside = z.from <= z.to ? u >= z.from && u < z.to : u >= z.from || u < z.to;
      if (inside) return z.kind;
    }
    return 'free';
  };

  const index = (s: number) => {
    const x = ((((s % length) + length) % length) / ds);
    const i = Math.floor(x) % count;
    return { i, j: (i + 1) % count, w: x - Math.floor(x) };
  };

  /** 距離 s のサンプルを線形補間して返す */
  function at(s: number) {
    const { i, j, w } = index(s);
    const A = samples[i];
    const B = samples[j];
    const tan = A.tan.clone().lerp(B.tan, w).normalize();
    const nor = A.nor.clone().lerp(B.nor, w);
    nor.addScaledVector(tan, -nor.dot(tan)).normalize();
    return {
      pos: A.pos.clone().lerp(B.pos, w),
      tan,
      nor,
      bin: new THREE.Vector3().crossVectors(tan, nor).normalize(),
      curv: A.curv.clone().lerp(B.curv, w),
      bank: A.bank + (B.bank - A.bank) * w,
      zone: zoneAtU(A.u),
    };
  }

  /**
   * 速度プロファイル v(s) からバンク角を決める。
   * 乗客が感じる力（遠心 + 重力の反力）が座面に垂直になる角度に傾け、横 G をほぼ 0 にする。
   */
  function applyBanking(speedAt: (s: number) => number) {
    const g = 9.81;
    const raw = samples.map((p) => {
      const v = speedAt(p.s);
      const f = p.curv.clone().multiplyScalar(v * v).add(new THREE.Vector3(0, g, 0));
      const fn = f.dot(p.nor);
      const fb = f.dot(p.bin);
      if (fn < 0.3 * g) return 0; // 浮く区間では傾けない
      return THREE.MathUtils.clamp(Math.atan2(fb, fn), -THREE.MathUtils.degToRad(d.maxBankDeg), THREE.MathUtils.degToRad(d.maxBankDeg));
    });
    const r = Math.round(d.bankSmoothing / ds);
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += raw[(i + k + count) % count];
      const bank = sum / (2 * r + 1);
      const p = samples[i];
      const n0 = p.nor.clone();
      const b0 = p.bin.clone();
      p.bank = bank;
      p.nor.copy(n0.multiplyScalar(Math.cos(bank)).addScaledVector(b0, Math.sin(bank))).normalize();
      p.bin.crossVectors(p.tan, p.nor).normalize();
    }
  }

  return { design: d, curve, length, samples, sampleStep: ds, at, zoneAtU, applyBanking };
}
