'use client';

import Link from 'next/link';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  cellDirs,
  DIR_VEC,
  findCell,
  nextCell,
  oppDir,
  PIECE_BY_KIND,
  PIECES,
  type Cell,
  type Dir,
  type PieceKind,
} from './pieces';
import { buildCourseFromCells, type BuildResult } from './courseBuilder';
import GridCanvas from './GridCanvas';

const GRID_COLS = 12;
const GRID_ROWS = 10;

/** ピースを回転させたときの見た目ラベル */
function rotLabel(rot: number) {
  return rot === 0 ? '' : `${rot * 90}°`;
}

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
        // スタートは削除不可。同じ場所をクリック → 回転 or 削除
        if (existing.kind === 'station') {
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
        // 別の種類 → 置き換え
        return prev.map((c) =>
          c.col === col && c.row === row ? { col, row, kind: selected, rot: 0 } : c
        );
      }
      // 空セルに新規配置
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

  // コースが一筆書きでスタートに戻ってきているか簡易チェック
  const { chain, looped } = useMemo(() => {
    const station = cells.find((c) => c.kind === 'station');
    if (!station) return { chain: [], looped: false };

    const visited: Cell[] = [station];
    let cur = station;
    for (let i = 0; i < cells.length * 2; i++) {
      const [nc, nr] = nextCell(cur);
      const next = findCell(cells, nc, nr);
      if (!next) break;
      // 入口が合っているか
      const { entry } = cellDirs(next);
      const { exit } = cellDirs(cur);
      if (entry !== oppDir(exit)) break;
      if (next === station) {
        return { chain: visited, looped: true };
      }
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
        <Link
          href="/simulator"
          className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-white/10"
        >
          シミュレーターへ →
        </Link>
      </header>

      <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
        {/* グリッド */}
        <div className="relative flex-1 overflow-auto bg-[#0f172a] p-2">
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
            左クリック：配置／回転 　右クリック：削除
          </p>
        </div>

        {/* サイドパネル */}
        <aside className="flex w-full flex-col gap-4 overflow-y-auto border-t border-white/10 bg-[#1e293b] p-4 lg:w-72 lg:border-l lg:border-t-0">
          {/* ピース選択 */}
          <section>
            <h2 className="mb-2 text-sm font-bold text-slate-300">線路ピース</h2>
            <div className="grid grid-cols-4 gap-1.5 lg:grid-cols-2">
              {PIECES.map((p) => (
                <button
                  key={p.kind}
                  onClick={() => setSelected(p.kind)}
                  className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-center text-xs transition-colors ${
                    selected === p.kind
                      ? 'border-sky-400 bg-sky-900/60 text-sky-200'
                      : 'border-white/10 hover:border-white/30 hover:bg-white/5'
                  }`}
                >
                  <span className="text-xl">{p.emoji}</span>
                  <span className="leading-tight">{p.label}</span>
                </button>
              ))}
            </div>
          </section>

          {/* 凡例 */}
          <section className="text-xs text-slate-400">
            <h2 className="mb-1 font-bold text-slate-300">つなぎ方</h2>
            <ul className="space-y-1">
              <li>• ピースの出口と次のピースの入口を合わせる</li>
              <li>• スタートに戻ってくるとループ完成 🔁</li>
              <li>• 同じ場所をクリックすると回転</li>
              <li>• 右クリックで削除</li>
            </ul>
          </section>

          {/* 状態表示 */}
          <section>
            <div className={`rounded-lg border px-3 py-2 text-sm ${
              looped
                ? 'border-green-500/50 bg-green-900/30 text-green-300'
                : 'border-yellow-500/40 bg-yellow-900/20 text-yellow-300'
            }`}>
              {looped ? (
                <>🔁 コースが完成しています！（{chain.length} ピース）</>
              ) : (
                <>⚠️ コースがつながっていません（{chain.length}/{cells.length} ピース接続）</>
              )}
            </div>
          </section>

          {/* ボタン群 */}
          <section className="flex flex-col gap-2">
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
          </section>

          {/* ヒント */}
          <section className="rounded-lg bg-white/5 px-3 py-2 text-xs leading-relaxed text-slate-400">
            <p className="mb-1 font-bold text-slate-300">ヒント</p>
            <p>スタートから始めて、右カーブ・左カーブで方向を変えながらスタートに戻ってくるとコースになります。登り・くだり・山・谷でアクセントをつけよう！</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
