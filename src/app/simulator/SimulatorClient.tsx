'use client';

import { useSearchParams } from 'next/navigation';
import { useMemo, Suspense } from 'react';
import CoasterSimulator from '@/components/simulator/CoasterSimulator';
import type { CourseDesign } from '@/components/coasterTrack';

function SimulatorWithParams() {
  const params = useSearchParams();
  const initialDesign = useMemo<CourseDesign | undefined>(() => {
    const raw = params.get('course');
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as CourseDesign;
    } catch {
      return undefined;
    }
  }, [params]);

  return <CoasterSimulator initialDesign={initialDesign} />;
}

export default function SimulatorClient() {
  return (
    <Suspense fallback={null}>
      <SimulatorWithParams />
    </Suspense>
  );
}
