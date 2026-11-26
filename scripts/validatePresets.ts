/**
 * ひな形ごとに推奨設定でシミュレーションを走らせ、期待結果と照合する
 *
 *   npx tsx scripts/validatePresets.ts
 *
 * 判定ルール：
 *   safe   : evaluateCourse が3条件すべてPASS かつ 300秒以内に1周して事故なし
 *   eject  : 300秒以内に eject イベントが出て、cause が一致する
 *   derail : 300秒以内に derail イベントが出る
 *   stall  : rollback と rest が出て、eject / derail は出ない
 *   gloc   : gloc が出て、eject / derail は出ない
 *   free   : 判定なし（常にPASS）
 */
import { evaluateCourse } from '../src/components/coasterSafety';
import { PRESETS, type PresetExpectation } from '../src/components/simulator/presets';
import { buildSimTrack, CoasterSim, DEFAULT_SETTINGS, type SimEvent } from '../src/components/simulator/simEngine';

const MAX_SIM_SECONDS = 300;
const DT = 1 / 60;

function runSim(preset: (typeof PRESETS)[number]): SimEvent[] {
  const settings = { ...DEFAULT_SETTINGS, ...preset.settings };
  const track = buildSimTrack(preset.design, settings);
  const sim = new CoasterSim(track, settings);
  sim.start();
  while (sim.time < MAX_SIM_SECONDS && sim.status === 'running') {
    sim.step(DT);
  }
  // 脱線後も物体の落下を追いかける（最大10秒）
  const extra = sim.time + 10;
  while (sim.time < extra && sim.status !== 'wrecked') {
    sim.step(DT);
  }
  return sim.events;
}

function hasCode(events: SimEvent[], code: string): boolean {
  return events.some((e) => e.code === code);
}

function ejectCause(events: SimEvent[]): string | undefined {
  const e = events.find((e) => e.code === 'eject');
  if (!e || e.code !== 'eject') return undefined;
  return e.cause;
}

function validate(events: SimEvent[], expect: PresetExpectation, design: (typeof PRESETS)[number]['design']): { pass: boolean; reason: string } {
  if (expect.kind === 'free') {
    return { pass: true, reason: '自由なコース（判定なし）' };
  }

  if (expect.kind === 'eject') {
    const ejected = hasCode(events, 'eject');
    if (!ejected) return { pass: false, reason: `投げ出しが発生しなかった（${MAX_SIM_SECONDS}秒以内）` };
    const cause = ejectCause(events);
    if (cause !== expect.cause) return { pass: false, reason: `投げ出しの原因が一致しない（期待 ${expect.cause}、実際 ${cause ?? 'なし'}）` };
    return { pass: true, reason: `${MAX_SIM_SECONDS}秒以内に eject（cause=${cause}）が発生` };
  }

  if (expect.kind === 'derail') {
    const derailed = hasCode(events, 'derail');
    if (!derailed) return { pass: false, reason: `脱線が発生しなかった（${MAX_SIM_SECONDS}秒以内）` };
    return { pass: true, reason: `${MAX_SIM_SECONDS}秒以内に derail が発生` };
  }

  if (expect.kind === 'stall') {
    const hasRollback = hasCode(events, 'rollback');
    const hasRest = hasCode(events, 'rest');
    const noEject = !hasCode(events, 'eject');
    const noDerail = !hasCode(events, 'derail');
    if (!hasRollback) return { pass: false, reason: 'rollback が発生しなかった' };
    if (!hasRest) return { pass: false, reason: 'rest が発生しなかった' };
    if (!noEject) return { pass: false, reason: 'eject が発生した（想定外）' };
    if (!noDerail) return { pass: false, reason: 'derail が発生した（想定外）' };
    return { pass: true, reason: 'rollback と rest が発生し、事故なし' };
  }

  if (expect.kind === 'gloc') {
    const hasGloc = hasCode(events, 'gloc');
    const noEject = !hasCode(events, 'eject');
    const noDerail = !hasCode(events, 'derail');
    if (!hasGloc) return { pass: false, reason: 'gloc が発生しなかった' };
    if (!noEject) return { pass: false, reason: 'eject が発生した（想定外）' };
    if (!noDerail) return { pass: false, reason: 'derail が発生した（想定外）' };
    return { pass: true, reason: 'gloc が発生し、事故なし' };
  }

  if (expect.kind === 'safe') {
    // evaluateCourse で3条件すべてPASS
    const reports = evaluateCourse(design);
    const allPass = reports.every((r) => r.ok);
    if (!allPass) {
      const failed = reports.filter((r) => !r.ok).map((r) => r.label).join(', ');
      return { pass: false, reason: `安全基準チェック不合格：${failed}` };
    }
    // 300秒以内に1周できて事故なし
    const hasLap = hasCode(events, 'lap');
    const noFail = !events.some((e) => e.kind === 'fail');
    if (!hasLap) return { pass: false, reason: `${MAX_SIM_SECONDS}秒以内に1周できなかった` };
    if (!noFail) {
      const fail = events.find((e) => e.kind === 'fail');
      return { pass: false, reason: `事故が発生した：${fail?.text}` };
    }
    return { pass: true, reason: '安全基準すべてPASSかつ事故なしで1周' };
  }

  return { pass: false, reason: '未知の期待結果' };
}

let allPassed = true;

for (const preset of PRESETS) {
  process.stdout.write(`\nひな形: ${preset.name}（${preset.id}）\n`);
  process.stdout.write(`  期待: ${preset.expect.kind}${'cause' in preset.expect ? `（cause=${preset.expect.cause}）` : ''}\n`);

  const events = runSim(preset);
  const result = validate(events, preset.expect, preset.design);

  if (result.pass) {
    process.stdout.write(`  ✅ PASS  ${result.reason}\n`);
  } else {
    process.stdout.write(`  ❌ FAIL  ${result.reason}\n`);
    allPassed = false;
  }

  // no-bank ひな形専用：banking: true にすると事故が0件になることを確認
  if (preset.id === 'no-bank') {
    process.stdout.write(`  追加チェック: banking: true で事故が0件\n`);
    const settingsWithBanking = { ...DEFAULT_SETTINGS, ...preset.settings, banking: true };
    const trackWithBanking = buildSimTrack(preset.design, settingsWithBanking);
    const simWithBanking = new CoasterSim(trackWithBanking, settingsWithBanking);
    simWithBanking.start();
    while (simWithBanking.time < MAX_SIM_SECONDS && simWithBanking.status === 'running') {
      simWithBanking.step(DT);
    }
    const bankingEvents = simWithBanking.events;
    const hasAnyFailure = bankingEvents.some((e) => e.kind === 'fail');
    const hasLapWithBanking = hasCode(bankingEvents, 'lap');
    if (!hasAnyFailure && hasLapWithBanking) {
      process.stdout.write(`  ✅ PASS  banking: true では事故なしで1周完了\n`);
    } else {
      const reason = !hasLapWithBanking ? '1周できなかった' : `事故が発生した（${bankingEvents.find((e) => e.kind === 'fail')?.text}）`;
      process.stdout.write(`  ❌ FAIL  banking: true にしても問題あり：${reason}\n`);
      allPassed = false;
    }
  }
}

process.stdout.write(`\n${allPassed ? '✅ すべてのひな形が期待どおりです' : '❌ 期待どおりでないひな形があります'}\n`);
process.exit(allPassed ? 0 : 1);
