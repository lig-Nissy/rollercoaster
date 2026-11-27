'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CourseDesign, Track, Waypoint } from '../coasterTrack';
import { evaluateCourse, type SafetyReport } from '../coasterSafety';
import CourseEditor, { type TrackPoint } from './CourseEditor';
import { LateralGauge, TelemetryChart, VerticalGauge } from './Gauges';
import { clonePreset, EXPECT_LABEL, PRESETS, type Preset } from './presets';
import { SimScene, type CameraMode } from './SimScene';
import {
  buildSimTrack,
  CoasterSim,
  DEFAULT_SETTINGS,
  physicsFor,
  RESTRAINTS,
  sanitizeDesign,
  type Restraint,
  type RiderStatus,
  type SimEvent,
  type SimSettings,
  type TrainStatus,
} from './simEngine';

type Tab = 'course' | 'train' | 'log';

type Snapshot = {
  status: TrainStatus;
  time: number;
  speed: number;
  gz: number;
  gy: number;
  gx: number;
  peakMin: number;
  peakMax: number;
  laps: number;
  zone: string;
  s: number;
  length: number;
  riders: { label: string; status: RiderStatus; unconscious: boolean; impactSpeed?: number }[];
  events: SimEvent[];
  vision: { grey: number; red: number };
  launchPhase: string;
  launchTimer: number;
};

const EMPTY_SNAPSHOT: Snapshot = {
  status: 'ready',
  time: 0,
  speed: 0,
  gz: 1,
  gy: 0,
  gx: 0,
  peakMin: 1,
  peakMax: 1,
  laps: 0,
  zone: 'station',
  s: 0,
  length: 0,
  riders: [],
  events: [],
  vision: { grey: 0, red: 0 },
  launchPhase: 'none',
  launchTimer: 0,
};

function snapshotOf(sim: CoasterSim): Snapshot {
  return {
    status: sim.status,
    time: sim.time,
    speed: sim.status === 'ready' ? 0 : sim.onTrack ? Math.abs(sim.ride.v) : sim.car.vel.length(),
    gz: sim.filtered.gz,
    gy: sim.filtered.gy,
    gx: sim.filtered.gx,
    peakMin: sim.peak.gzMin,
    peakMax: sim.peak.gzMax,
    laps: sim.laps,
    zone: sim.ride.zone,
    s: sim.ride.s,
    length: sim.track.length,
    riders: sim.riders.map((r) => ({ label: r.label, status: r.status, unconscious: r.unconscious, impactSpeed: r.impactSpeed })),
    events: sim.events.slice(-60),
    vision: sim.vision,
    launchPhase: sim.ride.launchPhase,
    launchTimer: sim.ride.launchTimer,
  };
}

const ZONE_KIND_NAME: Record<string, string> = { station: '駅', lift: '巻き上げ', trim: 'トリムブレーキ', brake: 'ブレーキ', launch: '発射' };

/** その点がどの区間の始まり・終わりか */
function roleOf(design: CourseDesign, label: string) {
  return design.zones
    .flatMap((z) => [
      z.from === label ? `${ZONE_KIND_NAME[z.kind]}の始まり` : null,
      z.to === label ? `${ZONE_KIND_NAME[z.kind]}の終わり` : null,
    ])
    .filter(Boolean)
    .join('・');
}

/** 線路の形に影響する設定だけを取り出したキー（同じなら線路を作り直さない） */
function trackKey(design: CourseDesign, s: SimSettings) {
  return JSON.stringify([design, s.banking, s.trims, s.brakes, s.liftSpeed]);
}

const STATUS_TEXT: Record<TrainStatus, string> = {
  ready: '駅で待機中',
  running: '走行中',
  derailed: '脱線',
  wrecked: '脱線して停止',
};

const ZONE_TEXT: Record<string, string> = {
  station: '駅',
  lift: '巻き上げ中',
  trim: 'トリムブレーキ',
  brake: 'ブレーキ',
  launch: '発射区間',
  free: '',
};

const RIDER_TEXT: Record<RiderStatus, string> = {
  seated: '着席',
  ejected: '投げ出された',
  landed: '地面に落下',
};

export default function CoasterSimulator({ initialDesign }: { initialDesign?: CourseDesign }) {
  const [presetId, setPresetId] = useState(initialDesign ? '' : 'standard');
  const [design, setDesign] = useState<CourseDesign>(() => initialDesign ?? clonePreset('standard'));
  const [settings, setSettings] = useState<SimSettings>(DEFAULT_SETTINGS);
  const [presetAppliedKeys, setPresetAppliedKeys] = useState<Set<keyof SimSettings>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [camera, setCamera] = useState<CameraMode>('rider');
  const [speedMul, setSpeedMul] = useState(1);
  const [paused, setPaused] = useState(false);
  const [tab, setTab] = useState<Tab>('course');
  const [buildError, setBuildError] = useState<string | null>(null);
  const [trackPath, setTrackPath] = useState<TrackPoint[]>([]);
  const [snap, setSnap] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [reports, setReports] = useState<{ key: string; list: SafetyReport[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SimScene | null>(null);
  const simRef = useRef<CoasterSim | null>(null);
  const trackKeyRef = useRef('');
  /** 最後に列車を作ったときのコースと設定（ページの再表示で作り直さないため） */
  const builtFromRef = useRef<{ design: CourseDesign; settings: SimSettings } | null>(null);
  const pausedRef = useRef(paused);
  const speedRef = useRef(speedMul);
  const cameraRef = useRef(camera);

  useEffect(() => {
    pausedRef.current = paused;
    speedRef.current = speedMul;
    cameraRef.current = camera;
  }, [paused, speedMul, camera]);

  // ---- 3D シーン（ページが隠れると片付け、再表示で作り直す） ----
  useEffect(() => {
    const container = containerRef.current!;
    const scene = new SimScene(container);
    sceneRef.current = scene;
    if (simRef.current) scene.setTrack(simRef.current.track);

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const sim = simRef.current;
      if (sim) {
        if (!pausedRef.current) {
          // 再生速度ぶんの時間を、1/60 秒以下の刻みで進める（描画が重くても実時間どおりに進む）
          let rest = dt * speedRef.current;
          while (rest > 1e-6) {
            const h = Math.min(1 / 60, rest);
            sim.step(h);
            rest -= h;
          }
        }
        scene.update(sim, cameraRef.current, dt);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const ui = setInterval(() => {
      if (simRef.current) setSnap(snapshotOf(simRef.current));
    }, 100);

    // ドラッグで視点を動かす
    let drag: { x: number; y: number } | null = null;
    const el = scene.renderer.domElement;
    const onDown = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      const dx = (e.clientX - drag.x) * 0.005;
      const dy = (e.clientY - drag.y) * 0.005;
      drag = { x: e.clientX, y: e.clientY };
      if (cameraRef.current === 'overview') {
        scene.orbit.angle += dx;
        scene.orbit.elevation = Math.min(1.4, Math.max(0.1, scene.orbit.elevation + dy));
      } else {
        scene.look.yaw = Math.max(-2.6, Math.min(2.6, scene.look.yaw - dx));
        scene.look.pitch = Math.max(-1.2, Math.min(1.2, scene.look.pitch - dy));
        scene.orbit.elevation = Math.min(1.4, Math.max(0, scene.orbit.elevation + dy));
      }
    };
    const onUp = () => {
      drag = null;
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(ui);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  // ---- コースや設定が変わったら作り直す（ドラッグ中は待つ） ----
  useEffect(() => {
    if (dragging) return;
    // 別ページから戻って Effect が再実行されただけなら、走行中の列車をそのまま続ける
    const built = builtFromRef.current;
    if (simRef.current && built && built.design === design && built.settings === settings) return;
    const id = setTimeout(() => {
      try {
        const key = trackKey(design, settings);
        let track: Track;
        if (simRef.current && key === trackKeyRef.current) {
          track = simRef.current.track; // 拘束装置や摩擦だけの変更なら線路はそのまま
        } else {
          track = buildSimTrack(design, settings);
          trackKeyRef.current = key;
          sceneRef.current?.setTrack(track);
          setTrackPath(track.samples.filter((_, i) => i % 6 === 0).map((p) => [p.pos.x, p.pos.z, p.pos.y, track.at(p.s).zone]));
        }
        simRef.current = new CoasterSim(track, settings);
        builtFromRef.current = { design, settings };
        sceneRef.current?.clearMarkers();
        setSnap(snapshotOf(simRef.current));
        setPaused(false);
        setBuildError(null);
      } catch (e) {
        setBuildError(e instanceof Error ? e.message : 'コースを作れませんでした');
      }
    }, 350);
    return () => clearTimeout(id);
  }, [design, settings, dragging]);

  // ---- 操作 ----
  const start = () => {
    simRef.current?.start();
    setPaused(false);
  };
  const reset = () => {
    const sim = simRef.current;
    if (!sim) return;
    simRef.current = new CoasterSim(sim.track, settings);
    sceneRef.current?.clearMarkers();
    setSnap(snapshotOf(simRef.current));
    setPaused(false);
  };
  const choosePreset = (id: string) => {
    const preset = PRESETS.find((p) => p.id === id)!;
    setPresetId(id);
    setDesign(clonePreset(id));
    setSettings({ ...DEFAULT_SETTINGS, ...preset.settings });
    setPresetAppliedKeys(new Set(Object.keys(preset.settings ?? {}) as (keyof SimSettings)[]));
    setSelected(null);
  };
  const updatePoint = (i: number, patch: Partial<{ x: number; z: number; h: number; sigma: number }>) => {
    setDesign((d) => {
      const w = [...d.waypoints];
      const [x, z, h, sigma, label] = w[i];
      w[i] = [patch.x ?? x, patch.z ?? z, patch.h ?? h, patch.sigma ?? sigma, label] as Waypoint;
      return { ...d, waypoints: w };
    });
  };
  const addPointAfter = (i: number) => {
    setDesign((d) => {
      const a = d.waypoints[i];
      const b = d.waypoints[(i + 1) % d.waypoints.length];
      const mid: Waypoint = [Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2), (a[2] + b[2]) / 2, (a[3] + b[3]) / 2];
      const w = [...d.waypoints];
      w.splice(i + 1, 0, mid);
      return { ...d, waypoints: w };
    });
    setSelected(i + 1);
  };
  const removePoint = (i: number) => {
    setDesign((d) => ({ ...d, waypoints: d.waypoints.filter((_, k) => k !== i) }));
    setSelected(null);
  };
  const runSafetyCheck = () => {
    setChecking(true);
    const key = trackKey(design, settings);
    // 計算に1〜2秒かかるので、表示を更新してから始める
    setTimeout(() => {
      try {
        const list = evaluateCourse(sanitizeDesign(design, { trims: true, brakes: true }), physicsFor({ ...settings, frictionScale: 1, dragScale: 1 }));
        setReports({ key, list });
      } catch (e) {
        setBuildError(e instanceof Error ? e.message : '確認できませんでした');
      }
      setChecking(false);
    }, 30);
  };

  const sel = selected !== null ? design.waypoints[selected] : null;
  const restraint = RESTRAINTS[settings.restraint];
  const failed = snap.status === 'derailed' || snap.status === 'wrecked' || snap.riders.some((r) => r.status !== 'seated');
  // 最初の事故（原因）を知らせる。2件目以降は「記録」タブで見られる
  const firstFail = snap.events.find((e) => e.kind === 'fail');
  const failCount = snap.events.filter((e) => e.kind === 'fail').length;
  const reportsStale = reports !== null && reports.key !== trackKey(design, settings);
  const pointCount = design.waypoints.length;
  const labelZones = useMemo(() => new Set(design.zones.flatMap((z) => [z.from, z.to])), [design.zones]);

  return (
    <div className="relative flex h-dvh flex-col bg-[#e9eef2] text-[#13202b] lg:flex-row">
      {/* ===== 3D ビュー ===== */}
      <section className="relative min-h-[55dvh] flex-1 overflow-hidden lg:min-h-0" aria-label="シミュレーション画面">
        <div ref={containerRef} className="absolute inset-0 cursor-grab active:cursor-grabbing" />

        {/* 視界（高い G で暗く、強い負の G で赤く） */}
        {camera === 'rider' && (
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background: `radial-gradient(ellipse at center, transparent ${Math.round(60 - snap.vision.grey * 55)}%, rgba(0,0,0,${snap.vision.grey}) 100%)`,
              boxShadow: snap.vision.red > 0 ? `inset 0 0 0 9999px rgba(200,20,30,${snap.vision.red * 0.5})` : undefined,
            }}
          />
        )}

        {/* 発射カウントダウン */}
        {snap.launchPhase === 'holding' && (
          <div className="pointer-events-none absolute inset-x-0 top-1/3 flex flex-col items-center gap-2">
            <div className="text-8xl font-bold tabular-nums text-white drop-shadow-lg" style={{ textShadow: '0 0 30px #ff6600' }}>
              {Math.ceil(snap.launchTimer)}
            </div>
            <div className="rounded-md bg-black/50 px-4 py-1 text-sm text-white backdrop-blur-sm">
              頭を背もたれにつけてください
            </div>
          </div>
        )}

        {/* 上の操作バー */}
        <header className="absolute inset-x-0 top-0 flex flex-wrap items-center gap-2 bg-gradient-to-b from-[#0d1b28cc] to-transparent px-4 pb-6 pt-3 text-white">
          <Link href="/" className="rounded-md px-2 py-1 text-sm text-[#cfe0ee] hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-[#ffc93c]">
            ← トップへ
          </Link>
          <h1 className="mr-auto text-lg font-bold tracking-tight">コースターシミュレーター</h1>
          {snap.status === 'ready' ? (
            <button onClick={start} className="rounded-md bg-[#ffc93c] px-5 py-1.5 font-bold text-[#13202b] hover:bg-[#ffd666] focus-visible:outline-2 focus-visible:outline-white">
              発車
            </button>
          ) : (
            <button onClick={() => setPaused((p) => !p)} className="rounded-md bg-white/15 px-4 py-1.5 font-medium hover:bg-white/25 focus-visible:outline-2 focus-visible:outline-[#ffc93c]">
              {paused ? '再開' : '一時停止'}
            </button>
          )}
          <button onClick={reset} className="rounded-md bg-white/15 px-4 py-1.5 font-medium hover:bg-white/25 focus-visible:outline-2 focus-visible:outline-[#ffc93c]">
            最初から
          </button>
          <div className="flex overflow-hidden rounded-md bg-white/10" role="group" aria-label="再生速度">
            {[1, 2, 4].map((n) => (
              <button
                key={n}
                onClick={() => setSpeedMul(n)}
                aria-pressed={speedMul === n}
                className={`px-2.5 py-1.5 text-sm tabular-nums ${speedMul === n ? 'bg-white text-[#13202b]' : 'hover:bg-white/15'}`}
              >
                ×{n}
              </button>
            ))}
          </div>
          <div className="flex overflow-hidden rounded-md bg-white/10" role="group" aria-label="視点">
            {(
              [
                ['rider', '乗客'],
                ['chase', '追いかけ'],
                ['overview', '全体'],
              ] as [CameraMode, string][]
            ).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setCamera(m)}
                aria-pressed={camera === m}
                className={`px-2.5 py-1.5 text-sm ${camera === m ? 'bg-white text-[#13202b]' : 'hover:bg-white/15'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        {/* 速度と状態 */}
        <div className="pointer-events-none absolute bottom-4 left-4 text-white" aria-live="polite">
          <div className="text-sm text-[#cfe0ee]">
            {STATUS_TEXT[snap.status]}
            {snap.status === 'running' && ZONE_TEXT[snap.zone] ? `・${ZONE_TEXT[snap.zone]}` : ''}
            {snap.length > 0 && `・${snap.s.toFixed(0)} / ${snap.length.toFixed(0)}m`}
          </div>
          <div className="font-[family-name:var(--font-geist-sans)] text-6xl font-bold leading-none tabular-nums" style={{ textShadow: '0 2px 12px rgba(0,0,0,0.5)' }}>
            {Math.round(snap.speed * 3.6)}
            <span className="ml-1 text-xl font-medium">km/h</span>
          </div>
          <ul className="mt-3 flex flex-wrap gap-2 text-sm">
            {snap.riders.map((r) => (
              <li
                key={r.label}
                className={`rounded-md px-2.5 py-1 ${r.status === 'seated' ? (r.unconscious ? 'bg-[#ffc93c] text-[#13202b]' : 'bg-[#0d1b28b3]') : 'bg-[#e5484d]'}`}
              >
                {r.label}：{r.unconscious && r.status === 'seated' ? '意識を失っている' : RIDER_TEXT[r.status]}
              </li>
            ))}
          </ul>
        </div>

        {/* G メーター */}
        <div className="pointer-events-none absolute right-2 top-28 flex origin-top-right scale-75 flex-col items-end gap-1 font-[family-name:var(--font-geist-sans)] text-white sm:top-20 sm:scale-100">
          <div className="pr-[118px] text-sm tabular-nums">上下G {snap.gz.toFixed(1)}</div>
          <VerticalGauge gz={snap.gz} peakMin={snap.peakMin} peakMax={snap.peakMax} restraint={settings.restraint} />
          {snap.launchPhase === 'firing' && (
            <div className="text-xs text-orange-300">前後G {snap.gx >= 0 ? '+' : ''}{snap.gx.toFixed(1)}</div>
          )}
        </div>
        <div className="pointer-events-none absolute bottom-4 right-4 hidden sm:block">
          <LateralGauge gy={snap.gy} restraint={settings.restraint} />
        </div>

        {/* 事故の知らせ */}
        {failed && firstFail && (
          <div role="alert" className="absolute left-4 top-20 w-[min(520px,calc(100%-180px))] rounded-md bg-[#e5484d] px-4 py-3 text-sm leading-relaxed text-white shadow-lg">
            {firstFail.text}
            {failCount > 1 && (
              <button onClick={() => setTab('log')} className="mt-1 block text-xs text-white/85 underline underline-offset-2 hover:text-white">
                ほか {failCount - 1} 件を記録で見る
              </button>
            )}
          </div>
        )}
        {buildError && (
          <div role="alert" className="absolute left-1/2 top-1/2 w-[min(440px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 rounded-md bg-white px-4 py-3 text-sm text-[#13202b] shadow-lg">
            {buildError}
          </div>
        )}

        {/* パネルトグルボタン（PCのみ） */}
        <button
          onClick={() => setPanelOpen(p => !p)}
          className="absolute right-0 top-1/2 z-10 hidden -translate-y-1/2 rounded-l-md border border-r-0 border-[#c9d3dc] bg-[#f5f7f9] px-1 py-3 text-xs text-[#5b6b79] hover:bg-[#e9eef2] lg:flex lg:flex-col lg:items-center"
          aria-label={panelOpen ? 'パネルを閉じる' : 'パネルを開く'}
        >
          {panelOpen ? '▶' : '◀'}
        </button>
      </section>

      {/* ===== 右パネル ===== */}
      <aside className={`flex flex-col border-[#c9d3dc] bg-[#f5f7f9] lg:border-l lg:transition-all lg:duration-300 ${panelOpen ? 'max-h-[45dvh] lg:max-h-none lg:w-[400px]' : 'max-h-[45dvh] lg:max-h-none lg:w-0 lg:border-l-0 lg:overflow-hidden'}`}>
        <nav className="flex border-b border-[#c9d3dc]" role="tablist" aria-label="設定">
          {(
            [
              ['course', 'コース'],
              ['train', '車両と装置'],
              ['log', '記録'],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`flex-1 px-3 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#1d5b93] ${
                tab === t ? 'border-b-2 border-[#13202b] text-[#13202b]' : 'text-[#5b6b79] hover:text-[#13202b]'
              }`}
            >
              {label}
              {t === 'log' && failed && <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-[#e5484d] align-middle" aria-label="事故あり" />}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {tab === 'course' && (
            <div className="space-y-5">
              <fieldset>
                <legend className="mb-2 text-sm font-bold">ひな形</legend>
                {(['safe', 'incident'] as const).map((group) => {
                  const groupPresets = PRESETS.filter((p) => p.group === group);
                  if (groupPresets.length === 0) return null;
                  return (
                    <div key={group} className="mb-3">
                      <p className="mb-1.5 text-xs font-medium text-[#5b6b79]">{group === 'safe' ? '安全なコース' : '事故の再現'}</p>
                      <div className="grid gap-1.5">
                        {groupPresets.map((p: Preset) => (
                          <label key={p.id} className={`flex cursor-pointer gap-2.5 rounded-md border px-3 py-2 ${presetId === p.id ? 'border-[#13202b] bg-white' : 'border-[#c9d3dc] hover:bg-white'}`}>
                            <input type="radio" name="preset" checked={presetId === p.id} onChange={() => choosePreset(p.id)} className="mt-1 accent-[#13202b]" />
                            <span>
                              <span className="block text-sm font-medium">{p.name}</span>
                              <span className="block text-xs text-[#5b6b79]">{p.description}</span>
                              <span className="mt-0.5 block text-xs text-[#1d5b93]">{EXPECT_LABEL[p.expect.kind]}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </fieldset>

              <div>
                <p className="mb-2 text-sm leading-relaxed text-[#4a5a68]">
                  点をドラッグしてコースを変えられます。選んだ点は矢印キーで 1m（Shift で 5m）ずつ動きます。
                </p>
                {trackPath.length > 0 && (
                  <CourseEditor
                    design={design}
                    trackPath={trackPath}
                    selected={selected}
                    onSelect={setSelected}
                    onMove={(i, x, z) => {
                      setDragging(true);
                      updatePoint(i, { x, z });
                    }}
                    onCommit={() => setDragging(false)}
                    coasterPos={snap.status === 'running' && simRef.current ? (() => {
                      const frame = simRef.current!.track.at(snap.s);
                      return { x: frame.pos.x, z: frame.pos.z, dx: frame.tan.x, dz: frame.tan.z };
                    })() : undefined}
                  />
                )}
              </div>

              {sel && selected !== null ? (
                <section className="space-y-3 rounded-md border border-[#c9d3dc] bg-white p-3" aria-label={`点 ${selected + 1} の設定`}>
                  <div className="flex items-baseline justify-between">
                    <h2 className="text-sm font-bold">点 {selected + 1}</h2>
                    <span className="font-[family-name:var(--font-geist-sans)] text-xs tabular-nums text-[#5b6b79]">
                      x {sel[0]}m・z {sel[1]}m
                    </span>
                  </div>
                  <label className="block text-sm">
                    <span className="flex justify-between">
                      高さ<span className="tabular-nums">{sel[2].toFixed(1)}m</span>
                    </span>
                    <input type="range" min={1} max={60} step={0.5} value={sel[2]} onChange={(e) => updatePoint(selected, { h: Number(e.target.value) })} className="w-full accent-[#13202b]" />
                  </label>
                  <label className="block text-sm">
                    <span className="flex justify-between">
                      丸め（小さいほど鋭い）<span className="tabular-nums">{sel[3].toFixed(1)}m</span>
                    </span>
                    <input type="range" min={1} max={20} step={0.5} value={sel[3]} onChange={(e) => updatePoint(selected, { sigma: Number(e.target.value) })} className="w-full accent-[#13202b]" />
                  </label>
                  <div className="flex gap-2">
                    <button onClick={() => addPointAfter(selected)} className="flex-1 rounded-md border border-[#13202b] px-3 py-1.5 text-sm hover:bg-[#e9eef2]">
                      次との間に点を追加
                    </button>
                    <button
                      onClick={() => removePoint(selected)}
                      disabled={(sel[4] !== undefined && labelZones.has(sel[4])) || pointCount <= 4}
                      className="rounded-md border border-[#c9d3dc] px-3 py-1.5 text-sm text-[#b42328] hover:bg-[#fdecec] disabled:cursor-not-allowed disabled:text-[#9aa7b2] disabled:hover:bg-transparent"
                    >
                      削除
                    </button>
                  </div>
                  {sel[4] !== undefined && labelZones.has(sel[4]) && (
                    <p className="text-xs leading-relaxed text-[#5b6b79]">
                      {roleOf(design, sel[4])}の目印なので削除できません。動かすことはできます。
                    </p>
                  )}
                </section>
              ) : (
                <p className="text-sm text-[#5b6b79]">点を選ぶと、高さと丸めを変えられます。</p>
              )}

              <section className="space-y-2">
                <h2 className="text-sm font-bold">安全基準の確認</h2>
                <p className="text-xs leading-relaxed text-[#5b6b79]">
                  バンク・トリム・ブレーキを有効にし、標準・悪条件・好条件の3条件で走らせて判定します（1〜2秒かかります）。
                </p>
                <button onClick={runSafetyCheck} disabled={checking} className="w-full rounded-md bg-[#13202b] px-3 py-2 text-sm font-medium text-white hover:bg-[#24384a] disabled:opacity-60">
                  {checking ? '確認しています…' : 'このコースを確認する'}
                </button>
                {reports && (
                  <div className={`space-y-2 ${reportsStale ? 'opacity-50' : ''}`}>
                    {reportsStale && <p className="text-xs text-[#5b6b79]">コースが変わったので、もう一度確認してください。</p>}
                    {reports.list.map((r) => (
                      <div key={r.label} className="rounded-md border border-[#c9d3dc] bg-white p-2.5">
                        <div className={`text-sm font-bold ${r.ok ? 'text-[#1f7a4d]' : 'text-[#b42328]'}`}>
                          {r.ok ? '合格' : '不合格'}：{r.label}
                        </div>
                        <ul className="mt-1 space-y-0.5 text-xs">
                          {r.checks.map((c) => (
                            <li key={c.name} className={c.pass ? 'text-[#4a5a68]' : 'font-medium text-[#b42328]'}>
                              {c.pass ? '✓' : '✗'} {c.name}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {tab === 'train' && (
            <div className="space-y-6">
              {presetAppliedKeys.size > 0 && (
                <p className="rounded-md bg-[#eef4fb] px-3 py-2 text-xs leading-relaxed text-[#1d5b93]">
                  ひな形の推奨設定を適用しています（★ のついた項目）
                </p>
              )}
              <fieldset>
                <legend className="mb-2 text-sm font-bold">拘束装置</legend>
                <div className="grid gap-1.5">
                  {(Object.keys(RESTRAINTS) as Restraint[]).map((k) => {
                    const r = RESTRAINTS[k];
                    return (
                      <label key={k} className={`flex cursor-pointer gap-2.5 rounded-md border px-3 py-2 ${settings.restraint === k ? 'border-[#13202b] bg-white' : 'border-[#c9d3dc] hover:bg-white'}`}>
                        <input type="radio" name="restraint" checked={settings.restraint === k} onChange={() => setSettings((s) => ({ ...s, restraint: k }))} className="mt-1 accent-[#13202b]" />
                        <span>
                          <span className="block text-sm font-medium">
                            {r.label}
                            {presetAppliedKeys.has('restraint') && settings.restraint === k && <span className="ml-1 text-[#1d5b93]">★</span>}
                          </span>
                          <span className="block text-xs tabular-nums text-[#5b6b79]">
                            {r.note}。上下G {r.gzMin} 未満・横G ±{r.gyAbs} 超で投げ出される
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <fieldset className="space-y-2.5">
                <legend className="mb-2 text-sm font-bold">線路の装置</legend>
                {(
                  [
                    ['banking', 'バンク（カーブで傾ける）', '切ると横Gがそのままかかる'],
                    ['trims', 'トリムブレーキ', '切ると速度のばらつきが大きくなる'],
                    ['brakes', '最終ブレーキ', '切ると駅に速いまま入る'],
                  ] as [keyof SimSettings, string, string][]
                ).map(([k, label, note]) => (
                  <label key={k} className="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={settings[k] as boolean}
                      onChange={(e) => setSettings((s) => ({ ...s, [k]: e.target.checked }))}
                      className="mt-1 accent-[#13202b]"
                    />
                    <span>
                      <span className="block text-sm">{label}</span>
                      <span className="block text-xs text-[#5b6b79]">{note}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              <fieldset className="space-y-3">
                <legend className="mb-2 text-sm font-bold">走る条件</legend>
                {(
                  [
                    ['frictionScale', '車輪の摩擦', 0.5, 3, 0.1, '×'],
                    ['dragScale', '空気抵抗', 0.5, 3, 0.1, '×'],
                    ['liftSpeed', '巻き上げの速さ', 2, 8, 0.5, 'm/s'],
                  ] as [keyof SimSettings, string, number, number, number, string][]
                ).map(([k, label, min, max, step, unit]) => (
                  <label key={k} className="block text-sm">
                    <span className="flex justify-between">
                      {label}
                      <span className="tabular-nums">
                        {unit === '×' ? `×${(settings[k] as number).toFixed(1)}` : `${settings[k]}${unit}`}
                      </span>
                    </span>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      step={step}
                      value={settings[k] as number}
                      onChange={(e) => setSettings((s) => ({ ...s, [k]: Number(e.target.value) }))}
                      className="w-full accent-[#13202b]"
                    />
                  </label>
                ))}
              </fieldset>

              <p className="text-xs leading-relaxed text-[#5b6b79]">
                設定を変えると列車は駅に戻ります。投げ出し・脱線・意識を失う G の値はこのシミュレーターの設定値で、実在の規格値ではありません。
              </p>
            </div>
          )}

          {tab === 'log' && (
            <div className="space-y-5">
              <TelemetryChart simRef={simRef} restraint={settings.restraint} />
              <dl className="grid grid-cols-3 gap-2 text-center font-[family-name:var(--font-geist-sans)]">
                <div className="rounded-md bg-white p-2">
                  <dt className="text-xs text-[#5b6b79]">最大の上下G</dt>
                  <dd className="text-lg font-bold tabular-nums">{snap.peakMax.toFixed(1)}</dd>
                </div>
                <div className="rounded-md bg-white p-2">
                  <dt className="text-xs text-[#5b6b79]">最小の上下G</dt>
                  <dd className="text-lg font-bold tabular-nums">{snap.peakMin.toFixed(1)}</dd>
                </div>
                <div className="rounded-md bg-white p-2">
                  <dt className="text-xs text-[#5b6b79]">周回</dt>
                  <dd className="text-lg font-bold tabular-nums">{snap.laps}</dd>
                </div>
              </dl>
              <section>
                <h2 className="mb-2 text-sm font-bold">できごと</h2>
                {snap.events.length === 0 ? (
                  <p className="text-sm text-[#5b6b79]">「発車」を押すと、ここに走行中のできごとが記録されます。</p>
                ) : (
                  <ol className="space-y-1.5 text-sm">
                    {[...snap.events].reverse().map((e, i) => (
                      <li key={`${e.t}-${i}`} className="flex gap-2">
                        <span className="w-12 shrink-0 text-right font-[family-name:var(--font-geist-sans)] tabular-nums text-[#5b6b79]">{e.t.toFixed(1)}s</span>
                        <span className={e.kind === 'fail' ? 'text-[#b42328]' : e.kind === 'warn' ? 'text-[#8a5a00]' : ''}>{e.text}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              <p className="text-xs text-[#5b6b79]">
                現在の拘束装置：{restraint.label}（上下G {restraint.gzMin} 未満・横G ±{restraint.gyAbs} 超で投げ出し）
              </p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
