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
