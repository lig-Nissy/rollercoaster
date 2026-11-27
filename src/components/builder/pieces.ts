/**
 * プラレールビルダー：線路ピースの定義
 *
 * グリッドは 1セル = 10m。ピースはセルをまたがずに 1 セルに収まる。
 * 各ピースは「入口方向」「出口方向」「高さ変化」を持つ。
 *
 * 方向は 0=北(+Z)、1=東(+X)、2=南(-Z)、3=西(-X) の 4 方向。
 * （SVG は Y 軸下向きなので、Z を Y として描く）
 */

export type Dir = 0 | 1 | 2 | 3; // N E S W

/** 方向ベクトル [dx, dz] */
export const DIR_VEC: [number, number][] = [
  [0, -1], // N
  [1, 0],  // E
  [0, 1],  // S
  [-1, 0], // W
];

export const DIR_NAME = ['北', '東', '南', '西'];

export type PieceKind =
  | 'station'   // スタート／ゴール（南北直線）
  | 'straight'  // 直線（南北）
  | 'curve_r'   // 右カーブ（北入 → 東出）
  | 'curve_l'   // 左カーブ（北入 → 西出）
  | 'up'        // 登り（南北、+5m）
  | 'down'      // くだり（南北、-5m）
  | 'hill'      // 山（南北、+8m → -8m）
  | 'dip'       // 谷（南北、先に-8m → +8m）

export type PieceDef = {
  kind: PieceKind;
  label: string;
  emoji: string;
  /** 入口の方向（南からセルに入る = 2） */
  entry: Dir;
  /** 出口の方向（セルから北へ出る = 0） */
  exit: Dir;
  /** 入口の高さ変化 [m]（次のピースへ引き継がれる） */
  dh: number;
  color: string;
};

export const PIECES: PieceDef[] = [
  { kind: 'station',  label: 'スタート',   emoji: '🏁', entry: 2, exit: 0, dh: 0,  color: '#6ea8ff' },
  { kind: 'straight', label: '直線',       emoji: '➡️', entry: 2, exit: 0, dh: 0,  color: '#94a3b8' },
  { kind: 'curve_r',  label: '右カーブ',   emoji: '↪️', entry: 2, exit: 1, dh: 0,  color: '#a78bfa' },
  { kind: 'curve_l',  label: '左カーブ',   emoji: '↩️', entry: 2, exit: 3, dh: 0,  color: '#a78bfa' },
  { kind: 'up',       label: '登り',       emoji: '⬆️', entry: 2, exit: 0, dh: 5,  color: '#34d399' },
  { kind: 'down',     label: 'くだり',     emoji: '⬇️', entry: 2, exit: 0, dh: -5, color: '#f87171' },
  { kind: 'hill',     label: '山',         emoji: '⛰️', entry: 2, exit: 0, dh: 0,  color: '#fbbf24' },
  { kind: 'dip',      label: '谷',         emoji: '🌊', entry: 2, exit: 0, dh: 0,  color: '#38bdf8' },
];

export const PIECE_BY_KIND = Object.fromEntries(PIECES.map((p) => [p.kind, p])) as Record<PieceKind, PieceDef>;

/** 方向を 90° 回転（rot=1 で右回り 90°） */
export function rotDir(d: Dir, rot: number): Dir {
  return (((d + rot) % 4 + 4) % 4) as Dir;
}

/** 反対方向 */
export function oppDir(d: Dir): Dir {
  return ((d + 2) % 4) as Dir;
}

/** グリッド上に置かれたピースの1セル */
export type Cell = {
  col: number;
  row: number;
  kind: PieceKind;
  /** 0=回転なし、1=右90°、2=180°、3=左90° */
  rot: number;
};

/** ピースの実際の entry/exit（rot を適用後） */
export function cellDirs(cell: Cell): { entry: Dir; exit: Dir } {
  const def = PIECE_BY_KIND[cell.kind];
  return {
    entry: rotDir(def.entry, cell.rot),
    exit: rotDir(def.exit, cell.rot),
  };
}

/** exit 方向に 1 セル進んだ [col, row] */
export function nextCell(cell: Cell): [number, number] {
  const { exit } = cellDirs(cell);
  const [dx, dz] = DIR_VEC[exit];
  return [cell.col + dx, cell.row + dz];
}

/** セルの列（グリッド col,row → ループ配列インデックス）を探す */
export function findCell(cells: Cell[], col: number, row: number): Cell | undefined {
  return cells.find((c) => c.col === col && c.row === row);
}
