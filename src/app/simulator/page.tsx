import type { Metadata } from 'next';
import SimulatorClient from './SimulatorClient';

export const metadata: Metadata = {
  title: 'コースターシミュレーター',
  description: 'コースを編集して走らせ、G・投げ出し・脱線を確かめるシミュレーター',
};

export default function SimulatorPage() {
  return <SimulatorClient />;
}
