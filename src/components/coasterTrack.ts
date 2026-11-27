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

/**
 * 区間ベースの立体要素の1区間。
 * 長さ length [m] の区間で、向きをピッチ・ヨー・ロールそれぞれ何度変えるかを指定する。
 * 曲率は区間の両端でゼロになるよう（sin²）なめらかに加える。
 */
export type ElementSegment = {
  length: number;
  pitch?: number; // ピッチ変化量 [deg]（上向きが正）
  yaw?: number;   // ヨー変化量 [deg]（左向きが正）
  roll?: number;  // ロール変化量 [deg]（時計回りが正）
};

/**
 * 区間リストから生成する立体要素。
 * 入口の向き（tan/nor/bin）から始め、各区間で向きを積分して線路点列を作る。
 * ロールはハートライン（線路から heartline m 上）を軸に行う。
 */
export type SegmentElement = {
  type: 'segment';
  /** 要素入口ウェイポイントのラベル */
  from: string;
  /** 要素出口ウェイポイントのラベル */
  to: string;
  /** 要素を構成する区間の並び */
  segments: ElementSegment[];
  /** ハートラインの高さ [m]（デフォルト 1.1） */
  heartline?: number;
  /** 表示ラベル（上から見た図に表示） */
  label?: string;
};

export type TrackElement = LoopElement | SegmentElement;

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
  /** 垂直ループ・立体要素（任意） */
  elements?: TrackElement[];
};

/**
 * 垂直ループのコントロールポイントを生成する。
 * 純粋な円形ループ（一定半径）を垂直平面上に生成し、
 * 入口・出口は水平方向から始まる。
 *
 * @param entry 入口の3D位置
 * @param dir   入口の水平進行方向（単位ベクトル）
 * @param loop  LoopElement の設定値
 */
function buildLoopPoints(
  entry: THREE.Vector3,
  dir: THREE.Vector2,
  loop: LoopElement,
): { pts: THREE.Vector3[] } {
  const { height, lateralOffset } = loop;

  // 円形ループの半径（高さの半分）
  const radius = height / 2;

  // 入口の進行方向と横方向
  const fwd = new THREE.Vector3(dir.x, 0, dir.y).normalize();
  const side = new THREE.Vector3(-dir.y, 0, dir.x).normalize();

  // ループの中心（入口から radius 分上）
  // 入口で水平進行しているので、ループ中心は入口の真上
  const center = entry.clone().add(new THREE.Vector3(0, radius, 0));

  const STEPS = 200;
  const pts: THREE.Vector3[] = [];

  for (let i = 0; i <= STEPS; i++) {
    // θ=0 で入口（中心から下）、θ=π で頂上（中心から上）、θ=2π で出口
    const theta = (i / STEPS) * 2 * Math.PI;

    // 円上の点：中心から下 → 前 → 上 → 後 → 下 の順（垂直平面上）
    // 入口で tan が fwd 方向（水平前進）になるように、
    // 入口点は center より下（-Y）、前進方向は +fwd
    // 角度の定義：θ=0 → (0, -radius) = 入口, θ=π/2 → (radius, 0) = 中間（前方）
    const loopX = radius * Math.sin(theta);    // 進行方向成分
    const loopY = -radius * Math.cos(theta);   // 高さ成分（θ=0 で -radius、θ=π で +radius）

    // 横ずれを smoothstep でなめらかに加える
    const t = i / STEPS;
    const lat = t * t * (3 - 2 * t);

    const world = center.clone()
      .addScaledVector(fwd, loopX)
      .add(new THREE.Vector3(0, loopY, 0))
      .addScaledVector(side, lat * lateralOffset);
    pts.push(world);
  }

  return { pts };
}

/**
 * 区間リストから立体要素の点列を生成する。
 *
 * 各区間で pitch/yaw/roll を sin² カーブでなめらかに加えながら、1m ステップで積分する。
 * ロールは乗客のハートライン（線路から heartline m 上）を軸に行う（ハートラインロール）。
 *
 * @param entryPos 入口の位置
 * @param entryTan 入口の接線（進行方向、単位ベクトル）
 * @param entryNor 入口の法線（上方向、単位ベクトル）
 * @param elem     SegmentElement の設定
 * @returns 1m 間隔の線路点列（入口を含む）
 */
function buildSegmentPoints(
  entryPos: THREE.Vector3,
  entryTan: THREE.Vector3,
  entryNor: THREE.Vector3,
  elem: SegmentElement,
): { pts: THREE.Vector3[]; nors: THREE.Vector3[] } {
  const heartlineH = elem.heartline ?? 1.1;
  const STEP = 0.5; // 積分ステップ [m]

  let pos = entryPos.clone();
  let tan = entryTan.clone().normalize();
  let nor = entryNor.clone().normalize();
  // bin = tan × nor（右方向）
  let bin = new THREE.Vector3().crossVectors(tan, nor).normalize();

  const pts: THREE.Vector3[] = [pos.clone()];
  const nors: THREE.Vector3[] = [nor.clone()];

  for (const seg of elem.segments) {
    const steps = Math.max(1, Math.round(seg.length / STEP));
    const ds = seg.length / steps;

    const pitchTotal = THREE.MathUtils.degToRad(seg.pitch ?? 0);
    const yawTotal   = THREE.MathUtils.degToRad(seg.yaw   ?? 0);
    const rollTotal  = THREE.MathUtils.degToRad(seg.roll  ?? 0);

    // sin² の累積（0→1→0 の速度プロファイル、積分すると 0→1 になる）
    // 位相 φ = π * t/T → 速度 ∝ sin²(φ)、累積 = t/T - sin(2πt/T)/(2π)
    const cumSin2 = (t: number) => t - Math.sin(2 * Math.PI * t) / (2 * Math.PI);
    const norm = cumSin2(1); // = 1

    for (let i = 0; i < steps; i++) {
      const t0 = i / steps;
      const t1 = (i + 1) / steps;
      const c0 = cumSin2(t0) / norm;
      const c1 = cumSin2(t1) / norm;

      const dPitch = pitchTotal * (c1 - c0);
      const dYaw   = yawTotal   * (c1 - c0);
      const dRoll  = rollTotal  * (c1 - c0);

      // ピッチ：tan を nor 方向へ回転。正のピッチ = 機首上げ（前進すると上る）
      // bin = tan × nor のとき、tan を nor 方向へ回すには +bin 軸まわりに正の角度
      if (Math.abs(dPitch) > 1e-9) {
        const q = new THREE.Quaternion().setFromAxisAngle(bin, dPitch);
        tan.applyQuaternion(q).normalize();
        nor.applyQuaternion(q).normalize();
        bin.crossVectors(tan, nor).normalize();
      }

      // ヨー：tan を bin 方向へ回転。正のヨー = 左向き
      // nor 軸まわりに回すと tan が bin 方向（右→左 = 正）に動く
      if (Math.abs(dYaw) > 1e-9) {
        const q = new THREE.Quaternion().setFromAxisAngle(nor, dYaw);
        tan.applyQuaternion(q).normalize();
        bin.applyQuaternion(q).normalize();
        nor.crossVectors(bin, tan).normalize();
      }

      // ロール（ハートラインロール）：
      // 乗客のハートライン位置（線路から nor 方向へ heartlineH）を軸に回転する。
      // 線路は heartlineH だけ離れた円弧上を移動する。
      if (Math.abs(dRoll) > 1e-9) {
        if (heartlineH > 0) {
          // ハートライン位置（現在の nor 方向への offset）
          const heartlineCenter = pos.clone().addScaledVector(nor, heartlineH);
          // tan 軸まわりに nor/bin を回転
          const q = new THREE.Quaternion().setFromAxisAngle(tan, dRoll);
          nor.applyQuaternion(q).normalize();
          bin.crossVectors(tan, nor).normalize();
          // 線路位置をハートラインから nor 逆方向へ heartlineH 移動
          pos.copy(heartlineCenter).addScaledVector(nor, -heartlineH);
        } else {
          // heartline = 0: ロール軸は線路中心（位置移動なし）
          const q = new THREE.Quaternion().setFromAxisAngle(tan, dRoll);
          nor.applyQuaternion(q).normalize();
          bin.crossVectors(tan, nor).normalize();
        }
      }

      pos.addScaledVector(tan, ds);
      pts.push(pos.clone());
      nors.push(nor.clone());
    }
  }

  return { pts, nors };
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

  // 要素（ループ・区間）の処理：u 範囲を記録する
  type ElemRange = { uFrom: number; uTo: number; element: TrackElement };
  const elemRanges: ElemRange[] = [];

  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < d.controlPoints; i++) {
    const u = i / d.controlPoints;
    const p = plan.at(u);
    pts.push(new THREE.Vector3(p.x, height(u), p.y));
  }

  // ヘルパー：コントロールポイント配列から指定範囲を要素点列で置き換える
  function replaceWithElemPts(elemPts: THREE.Vector3[], cpFrom: number, cpTo: number) {
    const margin = 8;
    const cpStart = Math.max(0, cpFrom - margin);
    const cpEnd = Math.min(d.controlPoints - 1, cpTo + margin);
    const replaceCount = cpEnd - cpStart + 1;

    for (let j = 0; j < replaceCount; j++) {
      const cp = cpStart + j;
      const t = (cp - cpFrom) / (cpTo - cpFrom);
      const eIdx = Math.max(0, Math.min(elemPts.length - 1, Math.round(t * (elemPts.length - 1))));

      if (cp >= cpFrom && cp <= cpTo) {
        pts[cp] = elemPts[eIdx].clone();
      } else {
        const blend = cp < cpFrom
          ? (cp - cpStart) / margin
          : (cpEnd - cp) / margin;
        const endIdx = cp < cpFrom ? 0 : elemPts.length - 1;
        const orig = pts[cp].clone();
        const end = elemPts[endIdx].clone();
        pts[cp] = orig.lerp(end, blend * blend * (3 - 2 * blend));
      }
    }
  }

  // 要素がある場合、対応するコントロールポイントを要素形状に置き換える
  if (d.elements) {
    for (const elem of d.elements) {
      const iFrom = d.waypoints.findIndex((w) => w[4] === elem.from);
      const iTo = d.waypoints.findIndex((w) => w[4] === elem.to);
      if (iFrom < 0 || iTo < 0) continue;

      const uFrom = plan.waypointU[iFrom];
      const uTo = plan.waypointU[iTo];
      elemRanges.push({ uFrom, uTo, element: elem });

      const cpFrom = Math.round(uFrom * d.controlPoints);
      const cpTo = Math.round(uTo * d.controlPoints);
      if (cpTo <= cpFrom) continue;

      if (elem.type === 'loop') {
        // 垂直ループ：コントロールポイントを置き換えて 3D 形状を作る
        const entryPos = pts[cpFrom].clone();
        const beforeIdx = Math.max(0, cpFrom - 3);
        const entryDir2D = new THREE.Vector2(
          pts[cpFrom].x - pts[beforeIdx].x,
          pts[cpFrom].z - pts[beforeIdx].z,
        ).normalize();
        const { pts: loopPts } = buildLoopPoints(entryPos, entryDir2D, elem);
        replaceWithElemPts(loopPts, cpFrom, cpTo);
      }
      // SegmentElement はコントロールポイントを変更しない。
      // サンプル生成後に nor/bin を直接変更する（後述）。
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

  // 要素区間の法線を再計算する
  // - ループ要素：平行輸送で法線を追跡（接線が大きく変わるため）
  // - 区間ベース要素：サンプルの弧長を使って ElementSegment の変化を逐次適用する
  //   位置（pos/tan）はフラットコースの CatmullRom をそのまま使い、nor/bin だけを変更する
  if (elemRanges.length > 0) {
    for (const er of elemRanges) {
      const iStart = samples.findIndex((s) => s.u >= er.uFrom);
      let iEnd = samples.findIndex((s) => s.u > er.uTo);
      if (iStart < 0) continue;
      if (iEnd < 0) iEnd = samples.length;

      // 出口の10m後まで影響を延長してなめらかに戻す
      const blendLen = Math.round(10 / ds);
      const iBlendEnd = Math.min(samples.length - 1, iEnd + blendLen);

      if (er.element.type === 'segment') {
        // 区間ベース要素：サンプルの弧長を使って段階的に nor/bin を変更する
        const elem = er.element;

        // 要素の全長を計算
        const elemTotalLen = elem.segments.reduce((sum, seg) => sum + seg.length, 0);
        const elemStartS = samples[iStart].s;
        const elemEndS = samples[Math.max(0, iEnd - 1)].s;
        const availableLen = elemEndS - elemStartS;

        // sin² の累積
        const cumSin2 = (t: number) => t - Math.sin(2 * Math.PI * t) / (2 * Math.PI);

        // 入口の nor/bin を初期値として設定
        const iEntrance = Math.max(0, iStart - 1);
        let norCur = samples[iEntrance].nor.clone();
        let tanCur = samples[iEntrance].tan.clone();
        let binCur = new THREE.Vector3().crossVectors(tanCur, norCur).normalize();

        // 要素の各セグメントを累積弧長で管理
        const segStarts: number[] = [];
        const segEnds: number[] = [];
        let acc = 0;
        for (const seg of elem.segments) {
          segStarts.push(acc);
          acc += seg.length;
          segEnds.push(acc);
        }

        for (let i = iStart; i < iEnd; i++) {
          const cur = samples[i];
          // 要素内の弧長（0〜elemTotalLen）
          const sInElem = availableLen > 0
            ? ((cur.s - elemStartS) / availableLen) * elemTotalLen
            : 0;

          // norCur/binCur を入口から sInElem まで積分
          // （毎サンプルで初期値から再計算）
          let norTemp = samples[iEntrance].nor.clone();
          let tanTemp = samples[iEntrance].tan.clone();
          let binTemp = new THREE.Vector3().crossVectors(tanTemp, norTemp).normalize();

          for (let si = 0; si < elem.segments.length; si++) {
            const seg = elem.segments[si];
            const segStart = segStarts[si];
            const segEnd = segEnds[si];
            if (sInElem <= segStart) break;

            const fraction = Math.min(1, (sInElem - segStart) / seg.length);
            const pitchTotal = THREE.MathUtils.degToRad(seg.pitch ?? 0);
            const yawTotal   = THREE.MathUtils.degToRad(seg.yaw   ?? 0);
            const rollTotal  = THREE.MathUtils.degToRad(seg.roll  ?? 0);

            const angleScale = cumSin2(fraction);

            if (Math.abs(pitchTotal) > 1e-9) {
              const q = new THREE.Quaternion().setFromAxisAngle(binTemp, pitchTotal * angleScale);
              tanTemp.applyQuaternion(q).normalize();
              norTemp.applyQuaternion(q).normalize();
              binTemp.crossVectors(tanTemp, norTemp).normalize();
            }
            if (Math.abs(yawTotal) > 1e-9) {
              const q = new THREE.Quaternion().setFromAxisAngle(norTemp, yawTotal * angleScale);
              tanTemp.applyQuaternion(q).normalize();
              binTemp.applyQuaternion(q).normalize();
              norTemp.crossVectors(binTemp, tanTemp).normalize();
            }
            if (Math.abs(rollTotal) > 1e-9) {
              const q = new THREE.Quaternion().setFromAxisAngle(tanTemp, rollTotal * angleScale);
              norTemp.applyQuaternion(q).normalize();
              binTemp.crossVectors(tanTemp, norTemp).normalize();
            }

            if (sInElem <= segEnd) break; // この区間で完了
          }

          // norTemp を cur.tan に直交化して適用
          norTemp.addScaledVector(cur.tan, -norTemp.dot(cur.tan)).normalize();
          if (norTemp.lengthSq() > 0.1) {
            cur.nor.copy(norTemp);
            cur.bin.crossVectors(cur.tan, cur.nor).normalize();
          }
        }

        // 出口後のブレンド：要素出口法線 → 通常（上向き投影）
        // 出口での nor を計算
        let norAtExit = samples[iEntrance].nor.clone();
        let tanAtExit = samples[iEntrance].tan.clone();
        let binAtExit = new THREE.Vector3().crossVectors(tanAtExit, norAtExit).normalize();
        for (const seg of elem.segments) {
          const pitchTotal = THREE.MathUtils.degToRad(seg.pitch ?? 0);
          const yawTotal   = THREE.MathUtils.degToRad(seg.yaw   ?? 0);
          const rollTotal  = THREE.MathUtils.degToRad(seg.roll  ?? 0);
          if (Math.abs(pitchTotal) > 1e-9) {
            const q = new THREE.Quaternion().setFromAxisAngle(binAtExit, pitchTotal);
            tanAtExit.applyQuaternion(q).normalize();
            norAtExit.applyQuaternion(q).normalize();
            binAtExit.crossVectors(tanAtExit, norAtExit).normalize();
          }
          if (Math.abs(yawTotal) > 1e-9) {
            const q = new THREE.Quaternion().setFromAxisAngle(norAtExit, yawTotal);
            tanAtExit.applyQuaternion(q).normalize();
            binAtExit.applyQuaternion(q).normalize();
            norAtExit.crossVectors(binAtExit, tanAtExit).normalize();
          }
          if (Math.abs(rollTotal) > 1e-9) {
            const q = new THREE.Quaternion().setFromAxisAngle(tanAtExit, rollTotal);
            norAtExit.applyQuaternion(q).normalize();
            binAtExit.crossVectors(tanAtExit, norAtExit).normalize();
          }
        }

        for (let i = iEnd; i <= iBlendEnd; i++) {
          const cur = samples[i];
          const t = (i - iEnd) / blendLen;
          const blend = t * t * (3 - 2 * t);
          const norNormal = up.clone().addScaledVector(cur.tan, -up.dot(cur.tan)).normalize();
          const blendedNor = norAtExit.clone().lerp(norNormal, blend);
          blendedNor.addScaledVector(cur.tan, -blendedNor.dot(cur.tan)).normalize();
          if (blendedNor.lengthSq() > 0.1) {
            cur.nor.copy(blendedNor);
            cur.bin.crossVectors(cur.tan, cur.nor).normalize();
          }
        }
      } else {
        // ループ要素：平行輸送で法線を追跡
        const iEntrance = Math.max(0, iStart - 1);
        let norPT = samples[iEntrance].nor.clone();

        for (let i = iStart; i <= iBlendEnd; i++) {
          const cur = samples[i];
          const prev = samples[i > 0 ? i - 1 : 0];

          const rotAxis = new THREE.Vector3().crossVectors(prev.tan, cur.tan);
          const sinA = rotAxis.length();
          if (sinA > 1e-6) {
            const cosA = prev.tan.dot(cur.tan);
            const angle = Math.atan2(sinA, cosA);
            const q = new THREE.Quaternion().setFromAxisAngle(rotAxis.divideScalar(sinA), angle);
            norPT.applyQuaternion(q);
          }
          norPT.addScaledVector(cur.tan, -norPT.dot(cur.tan)).normalize();

          if (i < iEnd) {
            cur.nor.copy(norPT);
          } else {
            const t = (i - iEnd) / blendLen;
            const blend = t * t * (3 - 2 * t);
            const norNormal = up.clone().addScaledVector(cur.tan, -up.dot(cur.tan)).normalize();
            cur.nor.copy(norPT.clone().lerp(norNormal, blend)).normalize();
          }
          cur.bin.crossVectors(cur.tan, cur.nor).normalize();
        }
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

  /** s が要素区間（ループ・立体要素）内かを返す */
  function inLoop(s: number): boolean {
    if (elemRanges.length === 0) return false;
    const { i } = index(s);
    const u = samples[i].u;
    return elemRanges.some((er) =>
      er.uFrom <= er.uTo ? u >= er.uFrom && u < er.uTo : u >= er.uFrom || u < er.uTo,
    );
  }

  return { design: d, curve, length, samples, sampleStep: ds, at, zoneAtU, applyBanking, inLoop, loopRanges: elemRanges };
}
