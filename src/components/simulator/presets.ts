import { COURSE, helix, type CourseDesign, type Waypoint } from '../coasterTrack';
import type { SimSettings } from './simEngine';

export type PresetExpectation =
  | { kind: 'safe' }
  | { kind: 'eject'; cause: 'gz' | 'gy' }
  | { kind: 'derail' }
  | { kind: 'stall' }
  | { kind: 'gloc' }
  | { kind: 'free' };

export type Preset = {
  id: string;
  name: string;
  description: string;
  group: 'safe' | 'incident';
  design: CourseDesign;
  settings?: Partial<SimSettings>;
  expect: PresetExpectation;
};

const clone = (d: CourseDesign): CourseDesign => ({
  ...d,
  waypoints: d.waypoints.map((w) => [...w] as Waypoint),
  zones: d.zones.map((z) => ({ ...z })),
});

/** 標準コースをもとに、丘を高く鋭く・カーブを急にした危険なコース */
const CREST_H = 22;
const CREST_S = 3;

function extreme(): CourseDesign {
  const d = clone(COURSE);
  const w = d.waypoints;
  const byLabel = (label: string) => w.findIndex((p) => p[4] === label);
  // キャメルバックを急な坂の鋭い山に作り替える
  const camel = byLabel('trim0');
  w.splice(camel, 2, [-64, 30, 5, 4], [-45, 30, CREST_H, CREST_S, 'trim0'], [-26, 30, 5, 4, 'trim0-end']);
  // ヘリックスを半径 12m に締める
  const start = w.findIndex((p) => p[4] === 'trim-end') + 1;
  const end = w.findIndex((p, i) => i > start && p[0] === 72 && p[1] === 12);
  w.splice(start, end - start, ...helix(100, 39, 12, 90, -540, 11, 3, 6));
  d.zones = d.zones.filter((z) => z.kind !== 'trim'); // トリムなし
  return d;
}

/** 標準コースをもとに、キャメルバックを低く鋭くして脱線させるコース */
function derail(): CourseDesign {
  const d = clone(COURSE);
  const w = d.waypoints;
  const byLabel = (label: string) => w.findIndex((p) => p[4] === label);
  // キャメルバックを高さ18m・丸め1mの鋭い山に作り替える（速度が落ちず頂上G が -3 を超える）
  const camel = byLabel('trim0');
  w.splice(camel, 2, [-64, 30, 5, 4], [-45, 30, 18, 1, 'trim0'], [-26, 30, 5, 4, 'trim0-end']);
  d.zones = d.zones.filter((z) => z.kind !== 'trim'); // トリムなし
  return d;
}

/**
 * ファミリー向け安全コース（Issue #3）
 * 巻き上げ 12.5m・全長 ~481m・最高速 50km/h 以下
 * 小さな丘 3 個（後ろほど低い）＋バンク付きカーブ
 * ヘリックス・交差・急な頂上なし
 *
 * 細長いD字形レイアウト：駅→直進（南）→巻き上げ→U ターン（右側・大半径）→北上しながら丘×3→ブレーキ→駅
 * 楕円（oval）が横長なのに対し、このコースは縦長で視覚的に異なる
 */
function family(): CourseDesign {
  const pts: Waypoint[] = [
    [-35, -25, 2, 3],               // 駅
    [-35, -25, 2, 3, 'lift'],       // 巻き上げ開始
    [-35, -60, 8, 5],               // 巻き上げ中
    [-35, -90, 12, 5],              // 巻き上げ中
    [-35, -110, 12.5, 6, 'lift-top'], // 巻き上げ頂上（12.5m）
    [-15, -145, 6, 8],              // ファーストドロップ（南東へ）
    [20, -150, 2.5, 12],            // U ターン入口
    [55, -138, 2.5, 14],            // U ターン（右側）
    [65, -112, 2.5, 14],            // U ターン（右側）
    [65, -88, 8, 10],               // 丘1（8m）
    [60, -60, 2.5, 12],             // 丘1 下り
    [55, -30, 2.5, 12],             // 緩い直線
    [50, 0, 6, 10],                 // 丘2（6m）
    [42, 25, 2, 12],                // 丘2 下り
    [25, 36, 4, 10],                // 丘3（4m）
    [5, 38, 2, 9],                  // 丘3 下り
    [-12, 32, 2, 8],                // 緩い左カーブ（大半径確保）
    [-28, 20, 2, 7, 'brake'],       // ブレーキ開始（南西向き）
    [-35, 5, 2, 5, 'brake-end'],    // ブレーキ終了（南向きで駅直前）
  ];
  return {
    ...clone(COURSE),
    waypoints: pts,
    zones: [
      { kind: 'station', from: 'brake-end', to: 'lift' },
      { kind: 'lift', from: 'lift', to: 'lift-top' },
      { kind: 'brake', from: 'brake', to: 'brake-end' },
    ],
    planSmoothing: 15,
    controlPoints: 600,
    maxBankDeg: 40,
    bankSmoothing: 30,
  };
}

/**
 * バンクなしで走ると急カーブで横に投げ出されるコース
 *
 * 設計：標準コースをベースに、谷直後の半径35m Uターンを半径20m に差し替え。
 * バンクなしでファーストドロップ後の約70km/h でUターンに入ると
 * 横G ≈ (70/3.6)² / (20 × 9.81) ≈ 2.14G となり、ラップバー限界(1.8G)を超える。
 * バンクをオンにすると横Gが打ち消されて安全に1周できる。
 */
function noBank(): CourseDesign {
  const d = clone(COURSE);
  const w = d.waypoints;
  // 谷直後の 35m U ターン（2段ヘリックス）を半径20m・1段に差し替える
  const valleyIdx = w.findIndex((p) => p[0] === -60 && p[1] === -40);
  const trim0Idx = w.findIndex((p) => p[4] === 'trim0');
  // 半径20m・180°の U ターン（center:-85,-5）
  // 中心は元と同じ -85,-5、radius=20（元は35）
  // -90°から -180° スイープ → 1段で折り返す
  w.splice(
    valleyIdx + 1,
    trim0Idx - valleyIdx - 1,
    ...helix(-85, -5, 20, -90, -180, 3, 5, 5, 10),
  );
  // 全トリムを外して速度を維持する
  d.zones = d.zones.filter((z) => z.kind !== 'trim');
  return d;
}

/** 手で編集しやすい、点の少ない楕円コース */
function oval(): CourseDesign {
  const pts: Waypoint[] = [
    [-60, 40, 2, 3],
    [-30, 40, 2, 3, 'lift'],
    [10, 40, 24, 5],
    [30, 38, 25, 6, 'lift-top'],
    [50, 25, 20, 8],
    [58, 0, 3, 10],
    [50, -25, 12, 8],
    [25, -40, 3, 8],
    [-5, -42, 9, 7],
    [-35, -40, 3, 8, 'brake'],
    [-60, -30, 3, 6],
    [-72, 0, 2.5, 5, 'brake-end'],
    [-70, 25, 2, 4],
  ];
  return {
    ...clone(COURSE),
    waypoints: pts,
    zones: [
      { kind: 'station', from: 'brake-end', to: 'lift' },
      { kind: 'lift', from: 'lift', to: 'lift-top' },
      { kind: 'brake', from: 'brake', to: 'brake-end' },
    ],
    controlPoints: 600,
  };
}

/**
 * 巻き上げ頂上（約17m）から1つ目の丘（約13m）は越えられるが、
 * 2つ目の丘（約20m）は越えられずに転がり戻るコース。
 * ロールバック後は1つ目の丘と2つ目の丘の間の谷（free 区間）で止まる。
 * 丘2手前の長い平坦区間で摩擦が大きく、ロールバック後のエネルギーが小さく早期に停止する。
 */
function stall(): CourseDesign {
  const pts: Waypoint[] = [
    // ブレーキ〜駅〜巻き上げ（タイヤ区間）
    [-55, 5, 2, 3, 'brake'],
    [-65, 0, 2, 3, 'brake-end'],
    [-50, -10, 2, 3],
    [-30, -15, 2, 3, 'lift'],
    // 巻き上げ（頂上 20m 設計 → 実際約17m）
    [0, -15, 20, 4, 'lift-top'],
    // ファーストドロップ → 長い低空飛行（摩擦を稼ぐ）
    [30, -5, 3, 5],
    [60, 10, 3, 5],
    [75, 30, 3, 5],
    // 1つ目の丘（15m 設計 → 実際約13m）→ 越えられる
    [70, 55, 15, 3, 'hill1-top'],
    // 2つの丘の間の谷（free 区間 → ロールバック後にここで止まる）
    [55, 65, 2, 4],
    // 2つ目の丘（24m 設計 → 実際約20m）→ 越えられない
    [40, 70, 24, 3, 'hill2-top'],
    // 折り返しカーブ（到達しない）
    [15, 68, 12, 6],
    [-5, 58, 3, 6],
    // 大回りで駅へ戻る
    [-20, 40, 2, 6],
    [-30, 20, 2, 5],
    [-45, 5, 2, 5],
  ];
  return {
    ...clone(COURSE),
    waypoints: pts,
    zones: [
      { kind: 'brake', from: 'brake', to: 'brake-end' },
      { kind: 'station', from: 'brake-end', to: 'lift' },
      { kind: 'lift', from: 'lift', to: 'lift-top' },
    ],
    controlPoints: 700,
    planSmoothing: 5,
  };
}

/**
 * 8の字交差コース（安全）
 *
 * 右半円（CW）と左半円（CCW）が交差部 (0,0) 付近で立体交差する縦型8の字。
 * 交差部：右半円を h=14 で南行き通過（高交差）、左半円前に h=2 で南行き通過（低交差）。
 * 高低差 12m により交差部クリアランス 12m 以上を確保。
 *
 * 経路:
 *   駅(北) → lift(北→南向き) → (0,0,h=14)[高交差] → 右半円CW[center(60,0),r=60]
 *   → trim(北方向→西) → (0,10,h=2)[低交差付近] → trim2(速度調整)
 *   → 左半円CCW[center(-60,20),r=60] → brake → 駅
 */
function figure8(): CourseDesign {
  const pts: Waypoint[] = [
    // 駅・巻き上げ（北側）
    [0, -120, 2, 3, 'lift'],
    [0, -80, 20, 7],
    [0, -40, 24, 8, 'lift-top'],
    // 高交差部 (0,0,h=14) → 右半円入口（南行きで入るため U-ターンなし）
    [0, 0, 14, 8],
    // 右半円（CW）: center(60,0), r=60, start(0,0) → end(120,0)
    // h=14→12 で entry/exit の高度差 2m により交差部クリアランスを補強
    ...helix(60, 0, 60, 180, -180, 14, 12, 11).slice(1),
    // 右半円 exit(120,0,h=12) → trim（北方向から緩やかに西へ）
    [120, -40, 12, 8, 'trim'],
    [60, -65, 2, 8, 'trim-end'],
    // 南行きで低交差部 (0,0,h=2) 付近を通過 → trim2 で速度調整
    [0, 10, 2, 8, 'trim2'],
    [0, 20, 2, 7, 'trim2-end'],
    // 左半円（CCW）: center(-60,20), r=60, start(0,20) → end(-120,20)
    ...helix(-60, 20, 60, 0, 180, 2, 2, 11).slice(1),
    // 左半円 exit(-120,20,h=2) → brake → 駅
    [-50, -50, 2, 7, 'brake'],
    [-48, -53, 2, 5, 'brake-end'],
  ];

  return {
    waypoints: pts,
    planSmoothing: 7,
    zones: [
      { kind: 'station', from: 'brake-end', to: 'lift' },
      { kind: 'lift', from: 'lift', to: 'lift-top' },
      { kind: 'trim', from: 'trim', to: 'trim-end', speed: 16 },
      { kind: 'trim', from: 'trim2', to: 'trim2-end', speed: 12 },
      { kind: 'brake', from: 'brake', to: 'brake-end' },
    ],
    controlPoints: 1200,
    maxBankDeg: 75,
    bankSmoothing: 10,
  };
}

export const EXPECT_LABEL: Record<PresetExpectation['kind'], string> = {
  safe: '安全に1周できる',
  eject: '乗客が投げ出される',
  derail: '列車が脱線する',
  stall: '途中で止まる',
  gloc: '乗客が意識を失う',
  free: '自由に試せる',
};

/**
 * エアタイムヒルズ（安全）：標準コースをベースに直線 3 丘を組み込んだコース
 *
 * 設計メモ
 *   標準コースの骨格（西側 U ターン後の z=30 直線）に丘 3 つを配置。
 *   S 字カーブはそのまま維持。ヘリックスを 1.5 周 → 0.5 周に短縮して
 *   悪条件のエネルギー消費を削減する。
 *
 *   変更点:
 *   1. U ターン出口〜trim（ヘリックス手前）の区間を差し替え
 *      - トリムゾーン（speed=17 m/s, 37m 制動区間）
 *      - 丘 1（h=13m, σ=7）・谷・丘 2（h=10m, σ=7）・S 字カーブ再利用
 *   2. ヘリックス区間を 1.5 周 → 0.5 周 (180°) に短縮
 *   3. ヘリックス後の最終区間は標準コースをそのまま使用
 */
function airtimeHills(): CourseDesign {
  const d = clone(COURSE);
  const w = d.waypoints;
  const idx = (label: string) => w.findIndex((p) => p[4] === label);

  // ── 1. U ターン出口〜trim の区間を 3 丘＋S 字に置換 ──
  const iFrom = w.findIndex((p) => p[0] === -85 && p[1] === 30);
  const iTo   = idx('trim');

  const replacement: Waypoint[] = [
    // トリムブレーキ（速度上限 17 m/s）
    [-85, 30, 4, 8, 'trim-at'],
    [-48, 30, 3, 8, 'trim-at-end'],
    // 丘 1（h=13m）― z=30 の直線上
    [-36, 30, 13, 7],
    [-24, 30, 3, 7],
    // 丘 2（h=10m）― 直線上
    [-12, 30, 10, 7],
    // S 字カーブ入口 → 標準コースの waypoint [17]〜[22] を再利用
    [-10, 30, 3, 10],
    ...(COURSE.waypoints.slice(18, 23) as Waypoint[]),
    [50.6, 65, 3, 8, 'trim'],
  ];
  w.splice(iFrom, iTo - iFrom + 1, ...replacement);
  d.zones = d.zones.filter((z) => z.from !== 'trim0');
  d.zones.push({ kind: 'trim', from: 'trim-at', to: 'trim-at-end', speed: 17 });

  // ── 2. 1.5 周ヘリックスを 0.5 周（180°）に短縮 ──
  // 標準コースのヘリックス: helix(100, 39, 26, 90, -540, 11, 3, 10)
  // → 0.5 周: helix(100, 39, 26, 90, -180, 11, 3, 10)
  // 置換対象: trim-end の次 〜 ホップ（waypoint [44] = [72, 12, 7, 7]）
  const iTrimEnd  = w.findIndex((p) => p[4] === 'trim-end') + 1;
  const iHop     = w.findIndex((p, i) => i > iTrimEnd && p[0] === 72 && p[1] === 12);
  const shortHelix: Waypoint[] = helix(100, 39, 26, 90, -180, 11, 3, 10);
  w.splice(iTrimEnd, iHop - iTrimEnd, ...shortHelix);

  return d;
}

export const PRESETS: Preset[] = [
  {
    id: 'standard',
    name: '標準コース',
    description: '安全基準をすべて満たすコース',
    group: 'safe',
    design: clone(COURSE),
    expect: { kind: 'safe' },
  },
  {
    id: 'extreme',
    name: '過激コース',
    description: '高く鋭い丘・半径12mのヘリックス・トリムなし',
    group: 'incident',
    design: extreme(),
    settings: { restraint: 'lapbar' },
    expect: { kind: 'eject', cause: 'gz' },
  },
  {
    id: 'derail',
    name: '事故の再現：鋭い山で脱線する',
    description: '高さ18m・丸め1mの鋭い山。頂上で45km/h以上の速度が残り、上下Gが補助輪の限界を超えて脱線する',
    group: 'incident',
    design: derail(),
    settings: { restraint: 'harness' },
    expect: { kind: 'derail' },
  },
  {
    id: 'family',
    name: 'ファミリーコース',
    description: '小さな丘とバンク付きカーブだけの安全なコース',
    group: 'safe',
    design: family(),
    expect: { kind: 'safe' },
  },
  {
    id: 'no-bank',
    name: 'ノーバンクカーブ',
    description: 'バンクなしの急カーブで横に投げ出されるコース。バンクをオンにすると走り切れます。',
    group: 'incident',
    design: noBank(),
    settings: { banking: false, restraint: 'lapbar' },
    expect: { kind: 'eject', cause: 'gy' },
  },
  {
    id: 'oval',
    name: '小さな楕円',
    description: '点が少なく、編集して試しやすいコース',
    group: 'safe',
    design: oval(),
    expect: { kind: 'free' },
  },
  {
    id: 'stall',
    name: '登り切れずに転がり戻る',
    description: '2つ目の丘を登り切れず、転がり戻って止まります',
    group: 'incident',
    design: stall(),
    expect: { kind: 'stall' },
  },
  {
    id: 'airtime',
    name: 'エアタイムヒルズ',
    description: '直線上に3つの丘が並ぶ、浮遊感のある安全なコース',
    group: 'safe',
    design: airtimeHills(),
    expect: { kind: 'safe' },
  },
  {
    id: 'figure8',
    name: '8の字交差コース',
    description: '右回りと左回りの輪を持つ立体交差コース。交差部の高低差は12m',
    group: 'safe',
    design: figure8(),
    expect: { kind: 'safe' },
  },
];

export const clonePreset = (id: string) => clone(PRESETS.find((p) => p.id === id)!.design);
