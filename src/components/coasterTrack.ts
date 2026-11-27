import * as THREE from 'three';

/**
 * コース定義と線路データの生成
 *
 * 設計の流れ
 *   1. 平面形：通過点（ウェイポイント）を CatmullRom でつなぎ、ガウシアンで丸める
 *      … 曲率が連続し、急に曲がり始めない（緩和曲線の代わり）
 *   2. 高さ：各ウェイポイントの高さを折れ線でつなぎ、ガウシアンで丸める
 *      … 勾配の折れ目が半径をもった曲線になり、上下 G の急変を防ぐ
 *   3. 速度プロファイルに合わせてバンク角を付ける … 横 G をほぼ 0 にする
 */

export type ZoneKind = 'station' | 'lift' | 'trim' | 'brake' | 'launch';
export type Zone = ZoneKind | 'free';

/** [x, z, 高さ h, 高さを丸める強さ σ, ラベル（ゾーン指定用・任意）] */
export type Waypoint = [x: number, z: number, h: number, sigma: number, label?: string];

/**
 * 垂直ループ要素。
 * from/to ラベルのウェイポイント間に、クロソイド形状の垂直ループを挿入する。
 * ループ区間のコントロールポイントはこの要素が生成した点に置き換えられる。
 */
export type LoopElement = {
  type: 'loop';
  /** ループ入口ウェイポイントのラベル */
  from: string;
  /** ループ出口ウェイポイントのラベル */
  to: string;
  /** 入口地点からループ頂上までの高さ [m] */
  height: number;
  /** ループの水平方向の最大幅 [m] */
  width: number;
  /** 出口の横ずれ [m]（入口の線路と重ならないよう 4.5 以上推奨） */
  lateralOffset: number;
  /** 頂上付近の最小半径 [m] */
  topRadius: number;
};

export type CourseDesign = {
  waypoints: Waypoint[];
  /** 平面形を丸める強さ σ [m] */
  planSmoothing: number;
  /**
   * ラベル from のウェイポイントから、ラベル to のウェイポイントの手前まで。
   * speed は trim（この速度を超えた分だけ減速）の目標速度 [m/s]
   */
  zones: { kind: ZoneKind; from: string; to: string; speed?: number; accel?: number; hold?: number }[];
  controlPoints: number; // CatmullRom に渡す点の数
  maxBankDeg: number; // バンク角の上限
  bankSmoothing: number; // バンク角を平均する距離 [m]（ロール速度を抑える）
  /** 垂直ループなどの3D要素（任意） */
  elements?: LoopElement[];
};

/**
 * 垂直ループのコントロールポイントを生成する。
 * クロソイド（入口/出口で曲率 0、頂上で最大曲率）を垂直平面上に積分する。
 * @param entry 入口の3D位置
 * @param dir   入口の進行方向（水平単位ベクトル）
 * @param loop  LoopElement の設定値
 * @returns コントロールポイント配列（入口〜出口）と出口位置・出口法線
 */
function buildLoopPoints(
  entry: THREE.Vector3,
  dir: THREE.Vector2, // 水平進行方向
  loop: LoopElement,
): { pts: THREE.Vector3[]; exitPos: THREE.Vector3; loopNormal: THREE.Vector2 } {
  const { height, width, lateralOffset, topRadius } = loop;
  // ループの形状：曲率を角度に対して滑らかに変化させ、360° 回る
  // 頂上（180°）で曲率最大（1/topRadius）、入口・出口（0°/360°）で曲率 0
  // → 曲率 κ(θ) = κ_max * sin²(θ/2) のような形（入口出口で 0、頂上で最大）
  // ただし κ_max は合計高さ・幅を満たすよう調整する。

  const STEPS = 120; // ループを何ステップで積分するか
  const dTheta = (2 * Math.PI) / STEPS;

  // 1パス目：形状の生成（κ_max = 1 と仮定して積分）
  let tanAngle = 0; // 垂直平面内の接線角（0 = 右方向（進行方向））
  let lx = 0; // ループ平面内の水平（進行方向）
  let ly = 0; // ループ平面内の垂直（高さ）
  const rawPts: [number, number][] = [[lx, ly]];
  for (let i = 0; i < STEPS; i++) {
    const theta = (i + 0.5) * dTheta;
    // 曲率: 入口・出口で 0、頂上（π）で最大、なめらかな teardrop 形状
    const kappa = (1 - Math.cos(theta)) * 0.5; // 0〜1 の範囲（頂上で 1）
    tanAngle += kappa * dTheta;
    lx += Math.cos(tanAngle) * dTheta;
    ly += Math.sin(tanAngle) * dTheta;
    rawPts.push([lx, ly]);
  }
  const rawWidth = Math.max(...rawPts.map(([x]) => Math.abs(x)));
  const rawHeight = Math.max(...rawPts.map(([, y]) => y));

  // 2パス目：スケールを合わせて実際の形状を計算
  const scaleX = (width / 2) / (rawWidth || 1);
  const scaleY = height / (rawHeight || 1);

  // 3パス目：実際のコントロールポイントを生成
  tanAngle = 0;
  lx = 0;
  ly = 0;

  // ループの水平方向（入口の進行方向）と横方向を計算
  const fwd = new THREE.Vector3(dir.x, 0, dir.y).normalize();
  const side = new THREE.Vector3(-dir.y, 0, dir.x).normalize(); // 左方向

  // 横ずれを dir に垂直な方向に適用（出口が入口とずれるように）
  const lateralVec = side.clone().multiplyScalar(lateralOffset);

  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const theta = i * dTheta;
    const kappa = (1 - Math.cos(theta)) * 0.5;
    if (i > 0) {
      tanAngle += kappa * dTheta;
      lx += Math.cos(tanAngle) * dTheta;
      ly += Math.sin(tanAngle) * dTheta;
    }
    // 横ずれを smoothstep でなめらかに加える
    const t = i / STEPS;
    const lat = t * t * (3 - 2 * t); // smoothstep
    const world = entry.clone()
      .addScaledVector(fwd, lx * scaleX)
      .add(new THREE.Vector3(0, ly * scaleY, 0))
      .addScaledVector(side, lat * lateralOffset);
    pts.push(world);
  }

  const exitPos = pts[pts.length - 1].clone();

  // ループの平面法線（入口進行方向に垂直な水平ベクトル）
  // = 入口の進行方向そのもの（ループは進行方向に沿った垂直平面上にある）
  const loopNormal = new THREE.Vector2(dir.x, dir.y);

  return { pts, exitPos, loopNormal };
}

/**
 * らせん（ヘリックス）のウェイポイントを作る
 * @param sweepDeg 回る角度（負なら時計回り）。360 を超えると線路が上下に重なる
 */
export function helix(
  cx: number, cz: number, r: number,
  startDeg: number, sweepDeg: number,
  h0: number, h1: number, sigma: number, stepDeg = 30,
): Waypoint[] {
  const n = Math.max(1, Math.round(Math.abs(sweepDeg) / stepDeg));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = THREE.MathUtils.degToRad(startDeg + (sweepDeg * i) / n);
    return [cx + r * Math.cos(a), cz + r * Math.sin(a), h0 + ((h1 - h0) * i) / n, sigma] as Waypoint;
  });
}

/**
 * レイアウト（上から見て x が右、z が下）
 *
 *   駅 → 巻き上げ（36m）→ 頂上で U ターン → ファーストドロップ（直線）
 *   → 西側のバンク付きカーブ → キャメルバック（エアタイム）→ S 字カーブ（切り返しで浮く）
 *   → トリム → 1.5 周の下りヘリックス → ホップ → U ターンの真下をくぐる → ブレーキ → 駅
 *
 * 設計ルール
 *   ・浮遊感のある丘の頂上は直線に置く（上下 G が小さいとバンクで横 G を打ち消せない）
 *   ・高速のカーブは谷か、上下 G がかかる区間に置いてバンクを付ける
 *   ・丘は後ろへ行くほど低くする（摩擦と空気抵抗でエネルギーが減る分の余裕）
 *   ・線路どうしが上下に交差・重なる所は 4m 以上離す（検証スクリプトでチェック）
 */
export const COURSE: CourseDesign = {
  waypoints: [
    [-100, -70, 2, 3], //              駅
    [-80, -70, 2, 3, 'lift'], //       巻き上げ開始
    [-30, -70, 35, 5], //
    [-12, -66, 36, 6, 'lift-top'], //  巻き上げ頂上（ここまでチェーン）→ U ターン
    [-4, -55, 35, 6],
    [-12, -44, 34, 8],
    [-30, -40, 30, 8], //              ファーストドロップ
    [-60, -40, 3, 14], //              谷（直線）
    ...helix(-85, -5, 35, -90, -90, 5, 12, 10, 30), // 西側の半径35m バンク付き U ターン（少し上る）
    ...helix(-85, -5, 35, -180, -90, 12, 4, 10, 30).slice(1),
    [-45, 30, 19, 9, 'trim0'], //     キャメルバック（エアタイム）＋ トリムブレーキ 0（S 字の速度をそろえる）
    [-30, 30, 14, 10, 'trim0-end'],
    ...helix(-10, 65, 35, -90, 60, 3, 10, 10, 20), // 谷 → S 字カーブ（右）… 切り返しの頂上で浮く
    ...helix(50.6, 30, 35, 150, -60, 10, 3, 8, 20).slice(1, -1), // S 字カーブ（左）
    [50.6, 65, 3, 8, 'trim'], //       トリムブレーキ 1（ヘリックスの速度をそろえる）
    [82, 65, 9, 8, 'trim-end'],
    ...helix(100, 39, 26, 90, -540, 11, 3, 10), // 半径26m・1.5 周の下りヘリックス
    [72, 12, 7, 7], //                 ホップ
    [45, 0, 3, 8, 'trim2'], //         トリムブレーキ 2（最終カーブの速度をそろえる）
    [20, -25, 3, 8, 'trim2-end'],
    [-5, -48, 3, 8], //                U ターンの真下をくぐる
    [-5, -62, 3, 8],
    ...helix(-45, -75, 40, 0, -90, 3, 3, 8, 30), // 半径40mの最終カーブ
    [-60, -115, 3, 6, 'brake'], //     ブレーキ区間
    [-90, -115, 2.5, 5, 'brake-end'],
    ...helix(-100, -92.5, 22.5, -90, -150, 2.5, 2, 4, 30).slice(1), // 駅へ戻る U ターン
  ],
  planSmoothing: 6,
  zones: [
    { kind: 'station', from: 'brake-end', to: 'lift' }, // 駅へ戻る U ターンもタイヤで送る
    { kind: 'lift', from: 'lift', to: 'lift-top' },
    { kind: 'trim', from: 'trim0', to: 'trim0-end', speed: 14 },
    { kind: 'trim', from: 'trim', to: 'trim-end', speed: 15 },
    { kind: 'trim', from: 'trim2', to: 'trim2-end', speed: 12.5 },
    { kind: 'brake', from: 'brake', to: 'brake-end' },
  ],
  controlPoints: 1200,
  maxBankDeg: 75,
  bankSmoothing: 8,
};

// ---------------------------------------------------------------------------
// 1. 平面形（ウェイポイント → CatmullRom → 1m 間隔 → ガウシアンで丸める）
// ---------------------------------------------------------------------------

function circularSmooth(values: number[], sigmaAt: (i: number) => number) {
  const n = values.length;
  return values.map((_, i) => {
    const sigma = Math.max(0.5, sigmaAt(i));
    const r = Math.ceil(sigma * 3);
    let sum = 0;
    let wsum = 0;
    for (let j = -r; j <= r; j++) {
      const w = Math.exp(-(j * j) / (2 * sigma * sigma));
      sum += w * values[(((i + j) % n) + n) % n];
      wsum += w;
    }
    return sum / wsum;
  });
}

function buildPlan(d: CourseDesign) {
  const W = d.waypoints.length;
  const base = new THREE.CatmullRomCurve3(
    d.waypoints.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    true,
    'centripetal',
  );

  // t を細かく刻んで累積長を作り、各ウェイポイントの位置 u（周長の割合）を求める
  const SUB = 200;
  const M = W * SUB;
  const cum = [0];
  let prev = base.getPoint(0);
  for (let i = 1; i <= M; i++) {
    const p = base.getPoint(i / M);
    cum.push(cum[i - 1] + p.distanceTo(prev));
    prev = p;
  }
  const total = cum[M];
  const waypointU = d.waypoints.map((_, i) => cum[i * SUB] / total);

  // 1m 間隔で取り直す
  const n = Math.ceil(total);
  const xs: number[] = [];
  const zs: number[] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const target = (i / n) * total;
    while (cum[k + 1] < target) k++;
    const w = (target - cum[k]) / (cum[k + 1] - cum[k] || 1);
    const p = base.getPoint((k + w) / M);
    xs.push(p.x);
    zs.push(p.z);
  }
  const sx = circularSmooth(xs, () => d.planSmoothing);
  const sz = circularSmooth(zs, () => d.planSmoothing);

  /** u（周長の割合）→ 平面座標 */
  function at(u: number) {
    const x = (((u % 1) + 1) % 1) * n;
    const i = Math.floor(x);
    const w = x - i;
    const j = (i + 1) % n;
    return new THREE.Vector2(sx[i % n] * (1 - w) + sx[j] * w, sz[i % n] * (1 - w) + sz[j] * w);
  }
  return { at, length: total, waypointU, samples: n };
}

// ---------------------------------------------------------------------------
// 2. 高さプロファイル（ウェイポイントの折れ線 → 可変幅ガウシアンで丸める）
// ---------------------------------------------------------------------------

function buildHeight(d: CourseDesign, waypointU: number[], n: number) {
  const W = waypointU.length;

  /** u におけるウェイポイント間の線形補間（idx 2 = 高さ, 3 = σ） */
  function lin(u: number, idx: 2 | 3) {
    for (let k = 0; k < W; k++) {
      const ua = waypointU[k];
      const ub = k + 1 === W ? 1 : waypointU[k + 1];
      if (u >= ua && u < ub) {
        const a = d.waypoints[k][idx];
        const b = d.waypoints[(k + 1) % W][idx];
        return a + ((b - a) * (u - ua)) / (ub - ua);
      }
    }
    return d.waypoints[0][idx];
  }

  const sketch = Array.from({ length: n }, (_, i) => lin(i / n, 2));
  const smoothed = circularSmooth(sketch, (i) => lin(i / n, 3));

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
  const height = buildHeight(d, plan.waypointU, plan.samples);

  // ゾーン：ラベル → u の範囲
  const labelU = (label: string) => {
    const i = d.waypoints.findIndex((w) => w[4] === label);
    if (i < 0) throw new Error(`ゾーンのラベル "${label}" がウェイポイントにありません`);
    return plan.waypointU[i];
  };
  const zoneRanges = d.zones.map((z) => ({ ...z, from: labelU(z.from), to: labelU(z.to) }));

  // ループ要素の処理：u 範囲 → ループ区間として記録
  type LoopRange = { uFrom: number; uTo: number; element: LoopElement };
  const loopRanges: LoopRange[] = [];

  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < d.controlPoints; i++) {
    const u = i / d.controlPoints;
    const p = plan.at(u);
    pts.push(new THREE.Vector3(p.x, height(u), p.y));
  }

  // ループ要素がある場合、対応するコントロールポイントをループ形状に置き換える
  if (d.elements) {
    for (const elem of d.elements) {
      if (elem.type !== 'loop') continue;
      const iFrom = d.waypoints.findIndex((w) => w[4] === elem.from);
      const iTo = d.waypoints.findIndex((w) => w[4] === elem.to);
      if (iFrom < 0 || iTo < 0) continue;

      const uFrom = plan.waypointU[iFrom];
      const uTo = plan.waypointU[iTo];
      loopRanges.push({ uFrom, uTo, element: elem });

      // 入口・出口のコントロールポイントインデックス
      const cpFrom = Math.round(uFrom * d.controlPoints);
      const cpTo = Math.round(uTo * d.controlPoints);
      if (cpTo <= cpFrom) continue;

      // 入口の位置と進行方向を計算（前後のコントロールポイントから）
      const entryPos = pts[cpFrom].clone();
      const beforeIdx = Math.max(0, cpFrom - 1);
      const afterIdx = Math.min(pts.length - 1, cpFrom + 1);
      const entryDir2D = new THREE.Vector2(
        pts[afterIdx].x - pts[beforeIdx].x,
        pts[afterIdx].z - pts[beforeIdx].z,
      ).normalize();

      // ループのコントロールポイントを生成
      const { pts: loopPts } = buildLoopPoints(entryPos, entryDir2D, elem);

      // ループ区間のコントロールポイントを置き換え
      const replaceCount = cpTo - cpFrom + 1;
      const loopStep = loopPts.length / replaceCount;
      for (let j = 0; j < replaceCount; j++) {
        const loopIdx = Math.min(loopPts.length - 1, Math.round(j * loopStep));
        pts[cpFrom + j] = loopPts[loopIdx].clone();
      }
    }
  }

  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  curve.arcLengthDivisions = d.controlPoints * 8;
  curve.updateArcLengths();
  const length = curve.getLength();

  const count = Math.round(length / sampleStep);
  const ds = length / count;
  const samples: TrackSample[] = [];
  const up = new THREE.Vector3(0, 1, 0);

  // ループ区間かどうかを s で判定するために、後で u → s のマッピングを使う
  // まず全サンプルを生成し、ループ区間だけ平行輸送で法線を再計算する
  for (let i = 0; i < count; i++) {
    const s = i * ds;
    const t = curve.getUtoTmapping(s / length, s);
    const pos = curve.getPoint(t);
    const tan = curve.getTangent(t).normalize();
    // 上方向を進行方向に直交化して「上」を作る
    // 垂直区間（ループ頂上など）では直前の向きを引き継ぐ（後で平行輸送で上書きされる）
    let nor = up.clone().addScaledVector(tan, -up.dot(tan));
    if (nor.lengthSq() < 0.01 && samples.length > 0) {
      nor = samples[samples.length - 1].nor.clone().addScaledVector(tan, -samples[samples.length - 1].nor.dot(tan));
    }
    nor.normalize();
    const bin = new THREE.Vector3().crossVectors(tan, nor).normalize();
    samples.push({ s, u: t, pos, tan, nor, bin, curv: new THREE.Vector3(), bank: 0 });
  }

  // ループ区間の法線を平行輸送で再計算する
  // u 値からループ区間のサンプルインデックス範囲を求める
  if (loopRanges.length > 0) {
    for (const lr of loopRanges) {
      // ループ区間のサンプルを u 値で絞り込む
      const iStart = samples.findIndex((s) => s.u >= lr.uFrom);
      let iEnd = samples.findIndex((s) => s.u > lr.uTo);
      if (iStart < 0) continue;
      if (iEnd < 0) iEnd = samples.length;

      // ループ出口の10m後まで平行輸送の影響を延長してなめらかに戻す
      const blendLen = Math.round(10 / ds);
      const iBlendEnd = Math.min(samples.length - 1, iEnd + blendLen);

      // 入口直前のサンプルの nor を初期値として平行輸送を開始
      const iEntrance = Math.max(0, iStart - 1);
      let norPT = samples[iEntrance].nor.clone();

      for (let i = iStart; i <= iBlendEnd; i++) {
        const cur = samples[i];
        const prev = samples[i > 0 ? i - 1 : 0];

        // 平行輸送：前の接線から現在の接線への回転を nor にも適用
        const rotAxis = new THREE.Vector3().crossVectors(prev.tan, cur.tan);
        const sinA = rotAxis.length();
        if (sinA > 1e-6) {
          const cosA = prev.tan.dot(cur.tan);
          const angle = Math.atan2(sinA, cosA);
          const q = new THREE.Quaternion().setFromAxisAngle(rotAxis.divideScalar(sinA), angle);
          norPT.applyQuaternion(q);
        }
        // tan に対して直交化
        norPT.addScaledVector(cur.tan, -norPT.dot(cur.tan)).normalize();

        if (i < iEnd) {
          // ループ区間内：平行輸送の法線をそのまま使う
          cur.nor.copy(norPT);
        } else {
          // 出口後：ブレンドして通常（上向き投影）に戻す
          const t = (i - iEnd) / blendLen;
          const blend = t * t * (3 - 2 * t); // smoothstep
          const norNormal = up.clone().addScaledVector(cur.tan, -up.dot(cur.tan)).normalize();
          cur.nor.copy(norPT.clone().lerp(norNormal, blend)).normalize();
        }
        cur.bin.crossVectors(cur.tan, cur.nor).normalize();
      }
    }
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

  const zoneInfoAtU = (u: number): { kind: Zone; speed?: number; accel?: number; hold?: number } => {
    for (const z of zoneRanges) {
      const inside = z.from <= z.to ? u >= z.from && u < z.to : u >= z.from || u < z.to;
      if (inside) return z;
    }
    return { kind: 'free' };
  };
  const zoneAtU = (u: number): Zone => zoneInfoAtU(u).kind;

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
      zoneSpeed: zoneInfoAtU(A.u).speed,
      zoneHold: zoneInfoAtU(A.u).hold,
      zoneAccel: zoneInfoAtU(A.u).accel,
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

  /** s がループ区間内かを返す */
  function inLoop(s: number): boolean {
    if (loopRanges.length === 0) return false;
    const { i } = index(s);
    const u = samples[i].u;
    return loopRanges.some((lr) =>
      lr.uFrom <= lr.uTo ? u >= lr.uFrom && u < lr.uTo : u >= lr.uFrom || u < lr.uTo,
    );
  }

  return { design: d, curve, length, samples, sampleStep: ds, at, zoneAtU, applyBanking, inLoop, loopRanges };
}
