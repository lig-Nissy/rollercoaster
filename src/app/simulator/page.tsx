import type { Metadata } from 'next';
import CoasterSimulator from '@/components/simulator/CoasterSimulator';

export const metadata: Metadata = {
  title: 'コースターシミュレーター',
  description: 'コースを編集して走らせ、G・投げ出し・脱線を確かめるシミュレーター',
};

export default function SimulatorPage() {
  return <CoasterSimulator />;
}
