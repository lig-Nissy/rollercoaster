'use client';

import { useRef, useState } from 'react';
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
  onCellMove: (fromCol: number, fromRow: number, toCol: number, toRow: number) => void;
};

function PieceSvg({ cell, inChain, looped, ghost }: { cell: Cell; inChain: boolean; looped: boolean; ghost?: boolean }) {
  const { entry, exit } = cellDirs(cell);
  const cx = CELL / 2;
  const cy = CELL / 2;

  const portXY = (d: number): [number, number] => {
    const [dx, dz] = DIR_VEC[d];
    return [cx + dx * cx, cy + dz * cy];
  };

  const [ex, ey] = portXY(entry);
  const [ox, oy] = portXY(exit);

  const trackColor = ghost ? '#38bdf888' : inChain ? (looped ? '#38bdf8' : '#7dd3fc') : '#334155';
  const fillColor = ghost ? '#1e293b66' : cell.kind === 'station' ? '#1e3a5f' : '#1e293b';
  const borderColor = ghost ? '#38bdf866' : inChain ? (looped ? '#38bdf8' : '#7dd3fc') : '#334155';

  const isCurve = cell.kind === 'curve_r' || cell.kind === 'curve_l';

  let heightIcon = '';
  if (cell.kind === 'up') heightIcon = '↑';
  if (cell.kind === 'down') heightIcon = '↓';
  if (cell.kind === 'hill') heightIcon = '∧';
  if (cell.kind === 'dip') heightIcon = '∨';

  return (
    <g opacity={ghost ? 0.5 : 1}>
      <rect x={1} y={1} width={CELL - 2} height={CELL - 2} rx={4} fill={fillColor} stroke={borderColor} strokeWidth={1.5} />
      {isCurve ? (
        <path d={`M ${ex} ${ey} Q ${cx} ${cy} ${ox} ${oy}`} fill="none" stroke={trackColor} strokeWidth={6} strokeLinecap="round" />
      ) : (
        <polyline points={`${ex},${ey} ${cx},${cy} ${ox},${oy}`} fill="none" stroke={trackColor} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" />
      )}
      {cell.kind === 'station' && (
        <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fontSize={14} fill="#6ea8ff">🏁</text>
      )}
      {heightIcon && (
        <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fontSize={13} fontWeight="bold" fill={trackColor}>{heightIcon}</text>
      )}
    </g>
  );
}

export default function GridCanvas({ cols, rows, cells, chain, looped, onCellClick, onCellRightClick, onCellMove }: Props) {
  const chainSet = new Set(chain.map((c) => `${c.col},${c.row}`));
  const svgRef = useRef<SVGSVGElement>(null);

  // ドラッグ状態
  const dragRef = useRef<{ cell: Cell; startX: number; startY: number } | null>(null);
  const [draggingCell, setDraggingCell] = useState<Cell | null>(null);
  const [ghostPos, setGhostPos] = useState<{ col: number; row: number } | null>(null);

  const w = cols * CELL;
  const h = rows * CELL;

  const cellMap = new Map(cells.map((c) => [`${c.col},${c.row}`, c]));

  const svgPos = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const col = Math.floor((clientX - rect.left) / CELL);
    const row = Math.floor((clientY - rect.top) / CELL);
    return { col, row };
  };

  const inBounds = (col: number, row: number) => col >= 0 && col < cols && row >= 0 && row < rows;

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const { col, row } = svgPos(e.clientX, e.clientY);
    if (!inBounds(col, row)) return;
    const cell = cellMap.get(`${col},${row}`);
    if (!cell) return;
    // ピース上でポインターキャプチャしてドラッグ開始
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    dragRef.current = { cell, startX: e.clientX, startY: e.clientY };
    setDraggingCell(cell);
    setGhostPos({ col, row });
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const { col, row } = svgPos(e.clientX, e.clientY);
    if (inBounds(col, row)) {
      setGhostPos({ col, row });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const drag = dragRef.current;
    dragRef.current = null;
    setDraggingCell(null);

    const { col, row } = svgPos(e.clientX, e.clientY);
    setGhostPos(null);

    const moved = col !== drag.cell.col || row !== drag.cell.row;
    const dx = Math.abs(e.clientX - drag.startX);
    const dy = Math.abs(e.clientY - drag.startY);
    const wasDrag = dx > 4 || dy > 4;

    if (!inBounds(col, row)) return;

    if (wasDrag && moved) {
      onCellMove(drag.cell.col, drag.cell.row, col, row);
    } else if (!wasDrag) {
      // ドラッグしていなければクリック扱い
      onCellClick(drag.cell.col, drag.cell.row);
    }
  };

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    // pointerDown/Up で処理済みのピースはスキップ。空セルへのクリックのみここで処理
    if (dragRef.current) return;
    const { col, row } = svgPos(e.clientX, e.clientY);
    if (!inBounds(col, row)) return;
    if (cellMap.has(`${col},${row}`)) return; // ピース上はpointerUpで処理済み
    onCellClick(col, row);
  };

  const handleContextMenu = (e: React.MouseEvent<SVGSVGElement>) => {
    e.preventDefault();
    const { col, row } = svgPos(e.clientX, e.clientY);
    if (!inBounds(col, row)) return;
    onCellRightClick(col, row);
  };

  const draggingKey = draggingCell ? `${draggingCell.col},${draggingCell.row}` : null;

  return (
    <svg
      ref={svgRef}
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="select-none rounded-lg border border-white/10 bg-[#0f172a]"
      style={{ cursor: draggingCell ? 'grabbing' : 'pointer' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {/* グリッド線 */}
      {Array.from({ length: cols + 1 }, (_, i) => (
        <line key={`v${i}`} x1={i * CELL} y1={0} x2={i * CELL} y2={h} stroke="#1e293b" strokeWidth={1} />
      ))}
      {Array.from({ length: rows + 1 }, (_, i) => (
        <line key={`h${i}`} x1={0} y1={i * CELL} x2={w} y2={i * CELL} stroke="#1e293b" strokeWidth={1} />
      ))}

      {/* 空セルのホバー */}
      {Array.from({ length: cols }, (_, col) =>
        Array.from({ length: rows }, (_, row) => {
          if (cellMap.has(`${col},${row}`)) return null;
          return (
            <rect key={`e${col},${row}`} x={col * CELL + 1} y={row * CELL + 1} width={CELL - 2} height={CELL - 2} fill="transparent" className="hover:fill-white/5" />
          );
        })
      )}

      {/* 配置済みピース（ドラッグ中のものは薄く） */}
      {cells.map((cell) => {
        const key = `${cell.col},${cell.row}`;
        const isDragging = key === draggingKey;
        return (
          <g key={key} transform={`translate(${cell.col * CELL}, ${cell.row * CELL})`} style={{ cursor: 'grab' }}>
            <PieceSvg cell={cell} inChain={chainSet.has(key)} looped={looped} ghost={isDragging} />
          </g>
        );
      })}

      {/* ドラッグ中のゴースト（移動先プレビュー） */}
      {draggingCell && ghostPos && (ghostPos.col !== draggingCell.col || ghostPos.row !== draggingCell.row) && (
        <g transform={`translate(${ghostPos.col * CELL}, ${ghostPos.row * CELL})`} style={{ pointerEvents: 'none' }}>
          <rect x={1} y={1} width={CELL - 2} height={CELL - 2} rx={4} fill="#38bdf822" stroke="#38bdf8" strokeWidth={2} strokeDasharray="4 2" />
        </g>
      )}

      {/* チェーンの進行方向ドット */}
      {chain.map((cell, i) => {
        if (i === chain.length - 1 && !looped) return null;
        const { exit } = cellDirs(cell);
        const [dx, dz] = DIR_VEC[exit];
        const cx = cell.col * CELL + CELL / 2;
        const cy = cell.row * CELL + CELL / 2;
        const ax = cx + dx * (CELL * 0.42);
        const ay = cy + dz * (CELL * 0.42);
        return <circle key={`a${i}`} cx={ax} cy={ay} r={3} fill={looped ? '#38bdf8' : '#7dd3fc'} opacity={0.7} />;
      })}
    </svg>
  );
}
