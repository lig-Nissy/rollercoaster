'use client';

import { useEffect, useRef } from 'react';
import { SimScene } from '../simulator/SimScene';
import { buildSimTrack, CoasterSim, DEFAULT_SETTINGS } from '../simulator/simEngine';
import type { CourseDesign } from '../coasterTrack';

type Props = {
  design: CourseDesign;
};

export default function BuilderPreview({ design }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let scene: SimScene | null = null;
    let sim: CoasterSim | null = null;
    let raf = 0;

    try {
      const track = buildSimTrack(design, DEFAULT_SETTINGS);
      sim = new CoasterSim(track, DEFAULT_SETTINGS);
      sim.start();

      scene = new SimScene(container);
      scene.setTrack(track);
      scene.orbit.angle = Math.PI * 0.6;
      scene.orbit.elevation = 0.6;

      let last = performance.now();
      const loop = (now: number) => {
        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;
        if (sim && scene) {
          let rest = dt;
          while (rest > 1e-6) {
            const h = Math.min(1 / 60, rest);
            sim.step(h);
            rest -= h;
          }
          scene.update(sim, 'chase', dt);
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    } catch {
      // buildSimTrack が失敗したときは何も表示しない
    }

    return () => {
      cancelAnimationFrame(raf);
      scene?.dispose();
    };
  }, [design]);

  return (
    <div ref={containerRef} className="h-full w-full" />
  );
}
