'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useCallback, useMemo, useState } from 'react';
import {
  cellDirs,
  findCell,
  nextCell,
  oppDir,
  PIECES,
  type Cell,
  type PieceKind,
} from './pieces';
import { buildCourseFromCells, type BuildResult } from './courseBuilder';
import GridCanvas from './GridCanvas';

const GRID_COLS = 12;
const GRID_ROWS = 10;

// Three.js は SSR 不可なので dynamic import
const BuilderPreview = dynamic(() => import('./BuilderPreview'), { ssr: false });

export default function TrackBuilder() {
  const [cells, setCells] = useState<Cell[]>([
    { col: 5, row: 7, kind: 'station', rot: 0 },
  ]);
  const [selected, setSelected] = useState<PieceKind>('straight');
  const [result, setResult] = useState<BuildResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const build = useCallback(() => {
    const r = buildCourseFromCells(cells);
    if (r.ok) {
      setResult(r);
      setError(null);
    } else {
      setResult(null);
      setError(r.error);
    }
  }, [cells]);

  const handleCellClick = useCallback((col: number, row: number) => {
    setCells((prev) => {
      const existing = findCell(prev, col, row);
      if (existing) {
        if (existing.kind === 'station') {
          // スタートは回転のみ（削除・置き換え不可）
          return prev.map((c) =>
            c.col === col && c.row === row ? { ...c, rot: ((c.rot + 1) % 4) as 0 | 1 | 2 | 3 } : c
          );
        }
        if (existing.kind === selected) {
          // 同じ種類 → 回転
          return prev.map((c) =>
            c.col === col && c.row === row ? { ...c, rot: ((c.rot + 1) % 4) as 0 | 1 | 2 | 3 } : c
          );
        }
        // 別の種類 → 置き換え（ただし station への置き換えは不可）
        if (selected === 'station') return prev;
        return prev.map((c) =>
          c.col === col && c.row === row ? { col, row, kind: selected, rot: 0 } : c
        );
      }
      // 空セルへの新規配置（station は1個のみ）
      if (selected === 'station') return prev;
      return [...prev, { col, row, kind: selected, rot: 0 }];
    });
    setResult(null);
    setError(null);
  }, [selected]);

  const handleCellRightClick = useCallback((col: number, row: number) => {
    setCells((prev) => {
      const existing = findCell(prev, col, row);
      if (!existing || existing.kind === 'station') return prev;
      return prev.filter((c) => !(c.col === col && c.row === row));
    });
    setResult(null);
    setError(null);
  }, []);

  const handleCellMove = useCallback((fromCol: number, fromRow: number, toCol: number, toRow: number) => {
    setCells((prev) => {
      const moving = findCell(prev, fromCol, fromRow);
      if (!moving) return prev;
      const target = findCell(prev, toCol, toRow);
      return prev.map((c) => {
        if (c.col === fromCol && c.row === fromRow) return { ...c, col: toCol, row: toRow };
        if (target && c.col === toCol && c.row === toRow) return { ...c, col: fromCol, row: fromRow };
        return c;
      });
    });
    setResult(null);
    setError(null);
  }, []);

  const reset = () => {
    setCells([{ col: 5, row: 7, kind: 'station', rot: 0 }]);
    setResult(null);
    setError(null);
  };

  // ループチェック
  const { chain, looped } = useMemo(() => {
    const station = cells.find((c) => c.kind === 'station');
    if (!station) return { chain: [], looped: false };

    const visited: Cell[] = [station];
    let cur = station;
    for (let i = 0; i < cells.length * 2; i++) {
      const [nc, nr] = nextCell(cur);
      const next = findCell(cells, nc, nr);
      if (!next) break;
      const { entry } = cellDirs(next);
      const { exit } = cellDirs(cur);
      if (entry !== oppDir(exit)) break;
      if (next === station) return { chain: visited, looped: true };
      if (visited.includes(next)) break;
      visited.push(next);
      cur = next;
    }
    return { chain: visited, looped: false };
  }, [cells]);

  const simulatorUrl = result?.ok
    ? `/simulator?course=${encodeURIComponent(JSON.stringify(result.design))}`
    : null;

  return (
    <div className="flex h-dvh flex-col bg-[#0f172a] text-white">
      {/* ヘッダー */}
      <header className="flex items-center gap-3 border-b border-white/10 bg-[#1e293b] px-4 py-3">
        <Link href="/" className="rounded-md px-2 py-1 text-sm text-slate-300 hover:bg-white/10">
          ← トップへ
        </Link>
        <h1 className="mr-auto font-bold tracking-tight">⚡ クイックビルダー</h1>
        <Link href="/simulator" className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-white/10">
          シミュレーターへ →
        </Link>
      </header>

      {/* メインエリア：グリッド ｜ 右カラム */}
      <div className="flex flex-1 overflow-hidden">
        {/* グリッド */}
        <div className="flex flex-1 flex-col overflow-auto bg-[#0f172a] p-2">
          <GridCanvas
            cols={GRID_COLS}
            rows={GRID_ROWS}
            cells={cells}
            chain={chain}
            looped={looped}
            onCellClick={handleCellClick}
            onCellRightClick={handleCellRightClick}
            onCellMove={handleCellMove}
          />
          <p className="mt-1 text-center text-xs text-slate-500">
            左クリック：配置／回転　右クリック：削除　ドラッグ：移動
          </p>
        </div>

        {/* 右カラム：3Dプレビュー ＋ 操作パネル */}
        <div className="flex w-72 flex-col border-l border-white/10">
          {/* 3D プレビュー */}
          <div className="relative border-b border-white/10 bg-[#0a1628]" style={{ height: '220px' }}>
            {result?.ok ? (
              <BuilderPreview design={result.design} key={JSON.stringify(result.design)} />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-slate-500">
                {looped ? '「コースを生成する」で3Dプレビューが表示されます' : 'コースをつなげると\n3Dプレビューが見られます'}
              </div>
            )}
          </div>

          {/* 操作パネル */}
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto bg-[#1e293b] p-4">
            {/* ピース選択 */}
            <section>
              <h2 className="mb-2 text-sm font-bold text-slate-300">線路ピース</h2>
              <div className="grid grid-cols-2 gap-1.5">
                {PIECES.map((p) => (
                  <button
                    key={p.kind}
                    onClick={() => setSelected(p.kind)}
                    disabled={p.kind === 'station'}
                    className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs transition-colors disabled:cursor-default disabled:opacity-40 ${
                      selected === p.kind
                        ? 'border-sky-400 bg-sky-900/60 text-sky-200'
                        : 'border-white/10 hover:border-white/30 hover:bg-white/5'
                    }`}
                  >
                    <span className="text-base">{p.emoji}</span>
                    <span>{p.label}</span>
                  </button>
                ))}
              </div>
            </section>

            {/* 状態 */}
            <div className={`rounded-lg border px-3 py-2 text-xs ${
              looped
                ? 'border-green-500/50 bg-green-900/30 text-green-300'
                : 'border-yellow-500/40 bg-yellow-900/20 text-yellow-300'
            }`}>
              {looped
                ? `🔁 ループ完成（${chain.length} ピース）`
                : `⚠️ 未接続（${chain.length}/${cells.length} ピース）`}
            </div>

            {/* ボタン群 */}
            <div className="flex flex-col gap-2">
              <button
                onClick={build}
                disabled={!looped}
                className="rounded-lg bg-sky-500 px-4 py-2.5 font-bold text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                コースを生成する
              </button>
              {simulatorUrl && (
                <Link
                  href={simulatorUrl}
                  className="rounded-lg bg-orange-500 px-4 py-2.5 text-center font-bold text-white transition-colors hover:bg-orange-400"
                >
                  🚀 シミュレーターで走らせる
                </Link>
              )}
              {error && (
                <p className="rounded-lg border border-red-500/40 bg-red-900/30 px-3 py-2 text-xs text-red-300">
                  {error}
                </p>
              )}
              <button
                onClick={reset}
                className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-400 hover:border-white/30 hover:text-white"
              >
                リセット
              </button>
            </div>

            <p className="text-xs leading-relaxed text-slate-500">
              スタートから始めて右・左カーブで方向転換しながらスタートに戻ってくるとコース完成。登り・山・谷でアクセントを。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
