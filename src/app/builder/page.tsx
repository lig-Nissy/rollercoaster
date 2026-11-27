import type { Metadata } from 'next';
import TrackBuilder from '@/components/builder/TrackBuilder';

export const metadata: Metadata = {
  title: 'プラレールビルダー',
  description: 'プラレール感覚でジェットコースターを組み立てて走らせよう',
};

export default function BuilderPage() {
  return <TrackBuilder />;
}
