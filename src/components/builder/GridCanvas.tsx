'use client';

import { useRef } from 'react';
import { cellDirs, DIR_VEC, PIECE_BY_KIND, type Cell } from './pieces';

const CELL = 56; // px per cell

type Props = {
  cols: number;
  rows: number;
  cells: Cell[];
  chain: Cell[];
  looped: boolean;
  onCellClick: (col: number, row: number) => void;
  onCellRightClick: (col: number, row: number) => void;
};

/** ピースを SVG で描く（セル内座標 0,0 ~ CELL,CELL） */
function PieceSvg({ cell, inChain, looped }: { cell: Cell; inChain: boolean; looped: boolean }) {
  const def = PIECE_BY_KIND[cell.kind];
  const { entry, exit } = cellDirs(cell);
  const cx = CELL / 2;
  const cy = CELL / 2;
  const r = CELL * 0.38;

  // 方向 → セルの端の中点
  const portXY = (d: number): [number, number] => {
    const [dx, dz] = DIR_VEC[d];
    return [cx + dx * cx, cy + dz * cy];
  };

  const [ex, ey] = portXY(entry);
  const [ox, oy] = portXY(exit);

  const trackColor = inChain ? (looped ? '#38bdf8' : '#7dd3fc') : '#334155';
  const fillColor = cell.kind === 'station' ? '#1e3a5f' : '#1e293b';
  const borderColor = inChain ? (looped ? '#38bdf8' : '#7dd3fc') : '#334155';

  // カーブは円弧で描く
  const isCurve = cell.kind === 'curve_r' || cell.kind === 'curve_l';

  // 高さ変化のアイコン
  let heightIcon = '';
  if (cell.kind === 'up') heightIcon = '↑';
  if (cell.kind === 'down') heightIcon = '↓';
  if (cell.kind === 'hill') heightIcon = '∧';
  if (cell.kind === 'dip') heightIcon = '∨';

  return (
    <g>
      {/* セル背景 */}
      <rect x={1} y={1} width={CELL - 2} height={CELL - 2} rx={4} fill={fillColor} stroke={borderColor} strokeWidth={1.5} />

      {/* 線路 */}
      {isCurve ? (
        // カーブは entry → exit を曲線で
        <path
          d={`M ${ex} ${ey} Q ${cx} ${cy} ${ox} ${oy}`}
          fill="none"
          stroke={trackColor}
          strokeWidth={6}
          strokeLinecap="round"
        />
      ) : (
        // 直線系は entry → center → exit
        <polyline
          points={`${ex},${ey} ${cx},${cy} ${ox},${oy}`}
          fill="none"
          stroke={trackColor}
          strokeWidth={6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}

      {/* 中央アイコン */}
      {cell.kind === 'station' && (
        <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fontSize={14} fill="#6ea8ff">
          🏁
        </text>
      )}
      {heightIcon && (
        <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fontSize={13} fontWeight="bold" fill={trackColor}>
          {heightIcon}
        </text>
      )}
    </g>
  );
}

export default function GridCanvas({ cols, rows, cells, chain, looped, onCellClick, onCellRightClick }: Props) {
  const chainSet = new Set(chain.map((c) => `${c.col},${c.row}`));
  const svgRef = useRef<SVGSVGElement>(null);

  const w = cols * CELL;
  const h = rows * CELL;

  const cellMap = new Map(cells.map((c) => [`${c.col},${c.row}`, c]));

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const col = Math.floor(x / CELL);
    const row = Math.floor(y / CELL);
    if (col < 0 || col >= cols || row < 0 || row >= rows) return;
    if (e.button === 2) {
      onCellRightClick(col, row);
    } else {
      onCellClick(col, row);
    }
  };

  return (
    <svg
      ref={svgRef}
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="cursor-pointer select-none rounded-lg border border-white/10 bg-[#0f172a]"
      onClick={handleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        handleClick(e as unknown as React.MouseEvent<SVGSVGElement>);
      }}
    >
      {/* グリッド線 */}
      {Array.from({ length: cols + 1 }, (_, i) => (
        <line key={`v${i}`} x1={i * CELL} y1={0} x2={i * CELL} y2={h} stroke="#1e293b" strokeWidth={1} />
      ))}
      {Array.from({ length: rows + 1 }, (_, i) => (
        <line key={`h${i}`} x1={0} y1={i * CELL} x2={w} y2={i * CELL} stroke="#1e293b" strokeWidth={1} />
      ))}

      {/* 空セルのヒント（ホバー可能な透明矩形） */}
      {Array.from({ length: cols }, (_, col) =>
        Array.from({ length: rows }, (_, row) => {
          if (cellMap.has(`${col},${row}`)) return null;
          return (
            <rect
              key={`e${col},${row}`}
              x={col * CELL + 1}
              y={row * CELL + 1}
              width={CELL - 2}
              height={CELL - 2}
              fill="transparent"
              className="hover:fill-white/5"
            />
          );
        })
      )}

      {/* 配置済みピース */}
      {cells.map((cell) => (
        <g key={`${cell.col},${cell.row}`} transform={`translate(${cell.col * CELL}, ${cell.row * CELL})`}>
          <PieceSvg
            cell={cell}
            inChain={chainSet.has(`${cell.col},${cell.row}`)}
            looped={looped}
          />
        </g>
      ))}

      {/* チェーンの矢印（出口方向） */}
      {chain.map((cell, i) => {
        if (i === chain.length - 1 && !looped) return null;
        const { exit } = cellDirs(cell);
        const [dx, dz] = DIR_VEC[exit];
        const cx = cell.col * CELL + CELL / 2;
        const cy = cell.row * CELL + CELL / 2;
        const ax = cx + dx * (CELL * 0.42);
        const ay = cy + dz * (CELL * 0.42);
        return (
          <circle key={`a${i}`} cx={ax} cy={ay} r={3} fill={looped ? '#38bdf8' : '#7dd3fc'} opacity={0.7} />
        );
      })}
    </svg>
  );
}
