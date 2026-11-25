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
 * ファミリー向け安全コース
 * 巻き上げ 13m・全長 ~380m・最高速 50km/h 以下
 * 小さな丘 3 個（後ろほど低い）＋バンク付きカーブ
 * ヘリックス・交差・急な頂上なし
 * 横G を抑えるため大きな半径でカーブする
 */
function family(): CourseDesign {
  // 楕円（oval）とは向きを反転させ、外周を反時計回りにする
  // 駅を左下、巻き上げを左→上方向、丘は上→右→下の順に配置
  // 細長い D 字形（縦長・出発と帰還が平行になるよう設計）
  // 重要: ブレーキ終了から駅へは同じ方向（北→南）に揃えて急カーブを防ぐ
  // 楕円（oval）が横長に対し、このコースは縦長で出発列方向が異なる
  // 細長い D 字形（縦長・出発と帰還が平行になるよう設計）
  // コンパクト化: 全長が 500m に収まるよう間隔を詰める
  const pts: Waypoint[] = [
    // 駅エリア: 南から来て、南へ出発するように揃える
    [-35, -25, 2, 3],               // ブレーキ終了から来る（南向き）
    [-35, -25, 2, 3, 'lift'],       // 巻き上げ開始（南向きのまま）
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

export const EXPECT_LABEL: Record<PresetExpectation['kind'], string> = {
  safe: '安全に1周できる',
  eject: '乗客が投げ出される',
  derail: '列車が脱線する',
  stall: '途中で止まる',
  gloc: '乗客が意識を失う',
  free: '自由に試せる',
};

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
];

export const clonePreset = (id: string) => clone(PRESETS.find((p) => p.id === id)!.design);
