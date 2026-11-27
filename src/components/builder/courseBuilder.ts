/**
 * グリッドのセル列 → CourseDesign への変換
 *
 * 各セルは 10m × 10m。セルの中心をウェイポイントとして使う。
 * カーブはセルの中心を通る CatmullRom に任せ、ウェイポイント間の距離は
 * 自動的に揃う。
 */

import type { CourseDesign, Waypoint } from '../coasterTrack';
import { cellDirs, DIR_VEC, findCell, nextCell, oppDir, PIECE_BY_KIND, type Cell } from './pieces';

export type BuildResult =
  | { ok: true; design: CourseDesign }
  | { ok: false; error: string };

const CELL_SIZE = 10; // m

/** ピース種類ごとの高さプロファイル [ピース内サンプル数, ...dh per sample] */
// 各ピースは entry から exit まで複数のウェイポイントを追加する
function waypointsForCell(
  cell: Cell,
  baseH: number,
  label: string | undefined,
): { points: Waypoint[]; nextH: number } {
  const kind = cell.kind;
  const def = PIECE_BY_KIND[kind];
  const { entry, exit } = cellDirs(cell);
  const cx = cell.col * CELL_SIZE;
  const cz = cell.row * CELL_SIZE;

  // 入口・出口の端点
  const [edx, edz] = DIR_VEC[entry];
  const [odx, odz] = DIR_VEC[exit];
  const entX = cx + edx * (CELL_SIZE / 2);
  const entZ = cz + edz * (CELL_SIZE / 2);
  const midX = cx;
  const midZ = cz;
  const exX = cx + odx * (CELL_SIZE / 2);
  const exZ = cz + odz * (CELL_SIZE / 2);

  const sigma = 4;

  switch (kind) {
    case 'station': {
      const h = Math.max(2, baseH);
      return {
        points: [
          [entX, entZ, h, sigma, label] as Waypoint,
          [midX, midZ, h, sigma] as Waypoint,
          [exX, exZ, h, sigma] as Waypoint,
        ],
        nextH: h,
      };
    }
    case 'straight': {
      return {
        points: [
          [entX, entZ, baseH, sigma] as Waypoint,
          [exX, exZ, baseH, sigma] as Waypoint,
        ],
        nextH: baseH,
      };
    }
    case 'curve_r':
    case 'curve_l': {
      // カーブはセル中心に制御点を追加して曲げる
      return {
        points: [
          [entX, entZ, baseH, sigma] as Waypoint,
          [midX, midZ, baseH, sigma] as Waypoint,
          [exX, exZ, baseH, sigma] as Waypoint,
        ],
        nextH: baseH,
      };
    }
    case 'up': {
      const nextH = baseH + 5;
      return {
        points: [
          [entX, entZ, baseH, sigma] as Waypoint,
          [exX, exZ, nextH, sigma] as Waypoint,
        ],
        nextH,
      };
    }
    case 'down': {
      const nextH = Math.max(2, baseH - 5);
      return {
        points: [
          [entX, entZ, baseH, sigma] as Waypoint,
          [exX, exZ, nextH, sigma] as Waypoint,
        ],
        nextH,
      };
    }
    case 'hill': {
      // 山：中央が +8m 高い
      const peak = baseH + 8;
      return {
        points: [
          [entX, entZ, baseH, sigma] as Waypoint,
          [midX, midZ, peak, 3] as Waypoint,
          [exX, exZ, baseH, sigma] as Waypoint,
        ],
        nextH: baseH,
      };
    }
    case 'dip': {
      // 谷：中央が -6m 低い（最低 2m）
      const floor = Math.max(2, baseH - 6);
      return {
        points: [
          [entX, entZ, baseH, sigma] as Waypoint,
          [midX, midZ, floor, 3] as Waypoint,
          [exX, exZ, baseH, sigma] as Waypoint,
        ],
        nextH: baseH,
      };
    }
  }
}

export function buildCourseFromCells(cells: Cell[]): BuildResult {
  // スタートを探す
  const station = cells.find((c) => c.kind === 'station');
  if (!station) return { ok: false, error: 'スタートピースがありません' };

  // チェーンを辿る
  const chain: Cell[] = [station];
  let cur = station;
  for (let i = 0; i < cells.length * 2; i++) {
    const [nc, nr] = nextCell(cur);
    const next = findCell(cells, nc, nr);
    if (!next) break;
    const { entry } = cellDirs(next);
    const { exit } = cellDirs(cur);
    if (entry !== oppDir(exit)) break;
    if (next === station) {
      // ループ完成
      break;
    }
    if (chain.includes(next)) break;
    chain.push(next);
    cur = next;
  }

  // ループしているか確認
  const [lc, lr] = nextCell(chain[chain.length - 1]);
  if (lc !== station.col || lr !== station.row) {
    return { ok: false, error: 'コースがスタートに戻ってきていません。ピースをつなぎ直してください' };
  }

  if (chain.length < 4) {
    return { ok: false, error: 'ピースが少なすぎます（最低4ピース必要）' };
  }

  // ウェイポイントを生成
  const waypoints: Waypoint[] = [];
  let h = 2; // 開始高さ

  // ステーション・リフト・ブレーキのゾーンを設定
  const stationLabel = 'station-start';
  const liftLabel = 'lift-start';
  const liftEndLabel = 'lift-end';
  const brakeLabel = 'brake-start';
  const brakeEndLabel = 'brake-end';

  // 最初の「登り」ピースを巻き上げ区間にする
  const firstUpIdx = chain.findIndex((c) => c.kind === 'up');
  const hasLift = firstUpIdx !== -1;

  for (let i = 0; i < chain.length; i++) {
    const cell = chain[i];
    let label: string | undefined;

    if (i === 0) label = stationLabel;
    else if (hasLift && i === firstUpIdx) label = liftLabel;
    else if (hasLift && i === firstUpIdx + 1) label = liftEndLabel;

    // ブレーキ：最後から2ピース目（ステーションの手前）
    if (i === chain.length - 2) label = brakeLabel;
    if (i === chain.length - 1) label = brakeEndLabel;

    const { points, nextH } = waypointsForCell(cell, h, label);
    h = nextH;

    // 重複ウェイポイントを除去（前のピースの exit と今のピースの entry は同じ座標）
    if (waypoints.length > 0 && i > 0) {
      points.shift();
    }
    waypoints.push(...points);
  }

  // ゾーン定義
  const zones: CourseDesign['zones'] = [
    { kind: 'station', from: brakeEndLabel, to: stationLabel },
  ];

  if (hasLift) {
    zones.push({ kind: 'lift', from: liftLabel, to: liftEndLabel });
  }

  zones.push({ kind: 'brake', from: brakeLabel, to: brakeEndLabel });

  const design: CourseDesign = {
    waypoints,
    planSmoothing: 5,
    zones,
    controlPoints: Math.max(400, waypoints.length * 8),
    maxBankDeg: 60,
    bankSmoothing: 6,
  };

  return { ok: true, design };
}
