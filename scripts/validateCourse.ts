/**
 * コースが安全基準（このプロジェクトの設計目標）を満たすかを走行シミュレーションで判定する
 *
 *   npx tsx scripts/validateCourse.ts
 *
 * 判定基準は src/components/coasterSafety.ts の SAFETY_LIMITS を参照。
 * 標準条件・悪条件（摩擦と空気抵抗 ×1.5）・好条件（×0.5）の3条件すべてで PASS なら終了コード 0。
 */
import { COURSE } from '../src/components/coasterTrack';
import { evaluateCourse } from '../src/components/coasterSafety';

const reports = evaluateCourse(COURSE);
for (const r of reports) {
  console.log(`\n${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.label}`);
  console.log(`   全長 ${r.length.toFixed(0)}m / 1周 ${r.lapTime.toFixed(1)}秒 / 最高 ${(r.maxSpeed * 3.6).toFixed(0)}km/h`);
  for (const c of r.checks) console.log(`   ${c.pass ? '✓' : '✗'} ${c.name}`);
}
process.exit(reports.every((r) => r.ok) ? 0 : 1);
