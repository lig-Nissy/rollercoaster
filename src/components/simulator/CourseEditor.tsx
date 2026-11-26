'use client';

import { useMemo, useRef } from 'react';
import type { CourseDesign, Waypoint, Zone } from '../coasterTrack';

export type TrackPoint = [x: number, z: number, y: number, zone: Zone];

/** 区間の色（線路の下に太く敷く） */
const ZONE_STYLE: Record<Exclude<Zone, 'free'>, { color: string; name: string }> = {
  station: { color: '#6ea8ff', name: '駅' },
  lift: { color: '#ffffff', name: '巻き上げ' },
  trim: { color: '#ff8c42', name: 'トリム' },
  brake: { color: '#ff5a5f', name: 'ブレーキ' },
};

type Props = {
  design: CourseDesign;
  /** 実際に作られた線路（上から見た座標と高さ）。未反映の間は古い形が出る */
  trackPath: TrackPoint[];
  /** コースター現在位置（トラック進行率 0〜1）。未走行時は null */
  coasterProgress: number | null;
  selected: number | null;
  onSelect: (i: number | null) => void;
  onMove: (i: number, x: number, z: number) => void;
  onCommit: () => void;
};

/** 高さ 0〜40m を淡い水色 → 黄色で表す */
function heightColor(h: number) {
  const k = Math.max(0, Math.min(1, h / 40));
  const a = [159, 211, 240];
  const b = [255, 201, 60];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')})`;
}

export default function CourseEditor({ design, trackPath, coasterProgress, selected, onSelect, onMove, onCommit }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<number | null>(null);

  // 表示範囲は「線路」と「点」の両方が入るように（ドラッグ中に枠が動かないよう線路基準で少し広めに）
  const view = useMemo(() => {
    const xs = [...trackPath.map((p) => p[0]), ...design.waypoints.map((w) => w[0])];
    const zs = [...trackPath.map((p) => p[1]), ...design.waypoints.map((w) => w[1])];
    const minX = Math.min(...xs) - 25;
    const maxX = Math.max(...xs) + 25;
    const minZ = Math.min(...zs) - 25;
    const maxZ = Math.max(...zs) + 25;
    return { minX, minZ, w: maxX - minX, h: maxZ - minZ };
    // 線路が作り直されたときだけ枠を更新する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackPath]);

  const zoneLabels = useMemo(() => new Set(design.zones.flatMap((z) => [z.from, z.to])), [design.zones]);

  const toWorld = (clientX: number, clientY: number) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: Math.round(p.x), z: Math.round(p.y) };
  };

  const grid = [];
  const step = 20;
  for (let x = Math.ceil(view.minX / step) * step; x < view.minX + view.w; x += step)
    grid.push(<line key={`x${x}`} x1={x} x2={x} y1={view.minZ} y2={view.minZ + view.h} />);
  for (let z = Math.ceil(view.minZ / step) * step; z < view.minZ + view.h; z += step)
    grid.push(<line key={`z${z}`} y1={z} y2={z} x1={view.minX} x2={view.minX + view.w} />);

  const scale = view.w / 360; // 画面上の大きさをほぼ一定に保つ係数
  const r = 2.6 * scale;

  const coasterPos = useMemo(() => {
    if (coasterProgress === null || trackPath.length < 2) return null;
    const idx = coasterProgress * (trackPath.length - 1);
    const i = Math.min(Math.floor(idx), trackPath.length - 2);
    const t = idx - i;
    const a = trackPath[i];
    const b = trackPath[i + 1];
    return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t };
  }, [coasterProgress, trackPath]);

  return (
    <div>
    <svg
      ref={svgRef}
      viewBox={`${view.minX} ${view.minZ} ${view.w} ${view.h}`}
      className="w-full rounded-md bg-[#173451] touch-none select-none"
      style={{ aspectRatio: `${view.w} / ${view.h}` }}
      role="application"
      aria-label="コースを上から見た図。点をドラッグするか、選んだ点を矢印キーで動かせます"
      onPointerMove={(e) => {
        if (dragRef.current === null) return;
        const { x, z } = toWorld(e.clientX, e.clientY);
        onMove(dragRef.current, x, z);
      }}
      onPointerUp={() => {
        if (dragRef.current !== null) onCommit();
        dragRef.current = null;
      }}
      onPointerLeave={() => {
        if (dragRef.current !== null) onCommit();
        dragRef.current = null;
      }}
      onPointerDown={(e) => {
        if (e.target === svgRef.current) onSelect(null);
      }}
    >
      <g stroke="#24486b" strokeWidth={0.6 * scale}>{grid}</g>

      {/* 点を結ぶ折れ線（編集の手がかり） */}
      <polygon
        points={design.waypoints.map((w) => `${w[0]},${w[1]}`).join(' ')}
        fill="none"
        stroke="#4f7aa3"
        strokeWidth={0.8 * scale}
        strokeDasharray={`${3 * scale} ${3 * scale}`}
      />

      {/* 区間（駅・巻き上げ・トリム・ブレーキ）を線路の下に太く敷く */}
      {trackPath.map((p, i) => {
        if (p[3] === 'free') return null;
        const q = trackPath[(i + 1) % trackPath.length];
        return (
          <line key={`z${i}`} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke={ZONE_STYLE[p[3]].color} strokeWidth={6 * scale} strokeLinecap="round" />
        );
      })}

      {/* 実際の線路（高さで色分け） */}
      {trackPath.map((p, i) => {
        const q = trackPath[(i + 1) % trackPath.length];
        return (
          <line
            key={i}
            x1={p[0]}
            y1={p[1]}
            x2={q[0]}
            y2={q[1]}
            stroke={heightColor(p[2])}
            strokeWidth={2.2 * scale}
            strokeLinecap="round"
          />
        );
      })}

      {/* コースター現在位置 */}
      {coasterPos && (
        <circle cx={coasterPos.x} cy={coasterPos.z} r={r * 1.8} fill="#ffc93c" stroke="#13202b" strokeWidth={0.8 * scale} />
      )}

      {/* 編集できる点 */}
      {design.waypoints.map((w: Waypoint, i) => {
        const isSel = i === selected;
        const isZoneMark = w[4] !== undefined && zoneLabels.has(w[4]);
        return (
          <g key={i}>
            <circle
              cx={w[0]}
              cy={w[1]}
              r={isSel ? r * 1.5 : r}
              fill={isSel ? '#ffc93c' : isZoneMark ? '#ffffff' : '#173451'}
              stroke={isSel ? '#173451' : '#ffffff'}
              strokeWidth={0.8 * scale}
              tabIndex={0}
              role="button"
              aria-label={`点 ${i + 1}、高さ ${w[2]}m${isZoneMark ? '、区間の目印' : ''}`}
              aria-pressed={isSel}
              className="cursor-grab outline-none focus-visible:stroke-[#ffc93c]"
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.target as Element).setPointerCapture?.(e.pointerId);
                dragRef.current = i;
                onSelect(i);
              }}
              onFocus={() => onSelect(i)}
              onKeyDown={(e) => {
                const d = e.shiftKey ? 5 : 1;
                const moves: Record<string, [number, number]> = {
                  ArrowLeft: [-d, 0],
                  ArrowRight: [d, 0],
                  ArrowUp: [0, -d],
                  ArrowDown: [0, d],
                };
                const m = moves[e.key];
                if (!m) return;
                e.preventDefault();
                onMove(i, w[0] + m[0], w[1] + m[1]);
              }}
              onKeyUp={(e) => {
                if (e.key.startsWith('Arrow')) onCommit();
              }}
            />
          </g>
        );
      })}
    </svg>
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#4a5a68]">
      <span className="flex items-center gap-1">
        <span className="inline-block h-1.5 w-8 rounded-full" style={{ background: `linear-gradient(90deg, ${heightColor(0)}, ${heightColor(40)})` }} />
        高さ 0〜40m
      </span>
      {Object.values(ZONE_STYLE).map((z) => (
        <span key={z.name} className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm border border-[#173451]" style={{ background: z.color }} />
          {z.name}
        </span>
      ))}
      <span className="flex items-center gap-1">
        <span className="inline-block h-2.5 w-2.5 rounded-full border border-[#173451] bg-white" />
        区間の目印
      </span>
    </div>
    </div>
  );
}
