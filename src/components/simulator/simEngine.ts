import * as THREE from 'three';
import { buildTrack, type CourseDesign, type Track } from '../coasterTrack';
import { bankForDesignSpeed, createPhysics, DEFAULT_PHYSICS, type PhysicsParams, type RideState } from '../coasterPhysics';

/**
 * コースターシミュレーターのエンジン
 *
 * 列車は線路上を物理モジュール（coasterPhysics）で走り、乗客と車輪にかかる G を毎ステップ監視する。
 *   ・乗客にかかる G が拘束装置の限界を超え続けると、その乗客は投げ出される
 *   ・車輪にかかる G が限界を超え続けると、列車ごと脱線する
 *   ・投げ出された乗客や脱線した車両は、空中を飛んで地面に落ちる（放物運動）
 *
 * 限界値は実在の規格値ではなく、このシミュレーターの設定値。
 * 拘束装置の種類による差は、ASTM F2291 の「加速度が大きいほど強い拘束が必要」という考え方を参考にしている。
 */

export type Restraint = 'none' | 'lapbar' | 'harness';

export const RESTRAINTS: Record<Restraint, { label: string; note: string; gzMin: number; gyAbs: number }> = {
  none: { label: 'なし', note: '浮く・横に振られると落ちる', gzMin: -0.2, gyAbs: 0.6 },
  lapbar: { label: 'ラップバー', note: '腰を押さえる', gzMin: -1.5, gyAbs: 1.8 },
  harness: { label: 'ショルダーハーネス', note: '肩から押さえる', gzMin: -2.5, gyAbs: 2.5 },
};

/** 車輪（上下・横の補助輪を含む）とレールが耐えられる限界 */
export const WHEEL_LIMITS = { gzMax: 6.5, gzMin: -3, gyAbs: 3 };

/** 人の体の限界（意識を失う） */
export const BODY_LIMITS = { glocGz: 4.5, glocSeconds: 2, recoverGz: 2, recoverSeconds: 3 };

/** 限界をこの秒数だけ超え続けたら発生する（一瞬のスパイクは無視） */
const SUSTAIN = 0.12;
const G = 9.81;

export type SimSettings = {
  restraint: Restraint;
  banking: boolean;
  trims: boolean;
  brakes: boolean;
  frictionScale: number;
  dragScale: number;
  liftSpeed: number;
};

export const DEFAULT_SETTINGS: SimSettings = {
  restraint: 'lapbar',
  banking: true,
  trims: true,
  brakes: true,
  frictionScale: 1,
  dragScale: 1,
  liftSpeed: DEFAULT_PHYSICS.liftSpeed,
};

export function physicsFor(settings: SimSettings): Partial<PhysicsParams> {
  return {
    rollingFriction: DEFAULT_PHYSICS.rollingFriction * settings.frictionScale,
    airDrag: DEFAULT_PHYSICS.airDrag * settings.dragScale,
    liftSpeed: settings.liftSpeed,
  };
}

/** 設定に合わせてゾーンを絞り込む（目印の点が消えたゾーンも外す） */
export function sanitizeDesign(design: CourseDesign, settings: Pick<SimSettings, 'trims' | 'brakes'>): CourseDesign {
  const labels = new Set(design.waypoints.map((w) => w[4]).filter(Boolean));
  const zones = design.zones.filter(
    (z) =>
      labels.has(z.from) &&
      labels.has(z.to) &&
      (settings.trims || z.kind !== 'trim') &&
      (settings.brakes || z.kind !== 'brake'),
  );
  return { ...design, zones };
}

/** 線路を作る */
export function buildSimTrack(design: CourseDesign, settings: SimSettings): Track {
  if (design.waypoints.length < 4) throw new Error('点が4つ未満です。コースを作るには4つ以上の点が必要です');
  const track = buildTrack(sanitizeDesign(design, settings));
  // バンクは標準の摩擦で決める（実物と同じく、設計速度で一度だけ決めて固定）
  if (settings.banking) bankForDesignSpeed(track, { liftSpeed: settings.liftSpeed });
  return track;
}

export type Body = {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  quat: THREE.Quaternion;
  spin: THREE.Vector3; // 角速度 [rad/s]
  resting: boolean;
};

export type RiderStatus = 'seated' | 'ejected' | 'landed';

export type Rider = {
  id: 'left' | 'right';
  label: string;
  seatX: number; // カートのローカル x（+ が左）
  status: RiderStatus;
  body: Body;
  glocTime: number;
  recoverTime: number;
  unconscious: boolean;
  impactSpeed?: number; // 地面に落ちたときの速さ [m/s]
};

export type TrainStatus = 'ready' | 'running' | 'derailed' | 'wrecked';

export type SimEvent = { t: number; kind: 'info' | 'warn' | 'fail'; text: string };

export type TelemetrySample = { t: number; v: number; gz: number; gy: number };

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const basis = new THREE.Matrix4();

function newBody(): Body {
  return { pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion(), spin: new THREE.Vector3(), resting: false };
}

/** 空中の物体を1ステップ進め、地面（y = radius）で跳ね返し・摩擦をかける。着地した瞬間に true を返す */
function integrateBody(b: Body, dt: number, radius: number): boolean {
  if (b.resting) return false;
  const wasAir = b.pos.y > radius + 0.05;
  b.vel.y -= G * dt;
  b.vel.multiplyScalar(1 - 0.02 * dt); // 空気抵抗（ごく弱く）
  b.pos.addScaledVector(b.vel, dt);
  const w = b.spin.length();
  if (w > 1e-4) {
    tmpQ.setFromAxisAngle(tmpV.copy(b.spin).divideScalar(w), w * dt);
    b.quat.premultiply(tmpQ);
  }
  let landed = false;
  if (b.pos.y <= radius) {
    b.pos.y = radius;
    if (wasAir) landed = true;
    if (b.vel.y < -2) b.vel.y = -b.vel.y * 0.25; // 跳ね返り
    else b.vel.y = 0;
    const k = Math.max(0, 1 - 4 * dt); // 地面との摩擦
    b.vel.x *= k;
    b.vel.z *= k;
    b.spin.multiplyScalar(Math.max(0, 1 - 5 * dt));
    if (b.vel.length() < 0.15 && b.pos.y <= radius + 1e-3) {
      b.vel.set(0, 0, 0);
      b.spin.set(0, 0, 0);
      b.resting = true;
    }
  }
  return landed;
}

export class CoasterSim {
  readonly track: Track;
  readonly settings: SimSettings;
  private physics: ReturnType<typeof createPhysics>;

  ride: RideState;
  status: TrainStatus = 'ready';
  time = 0;
  laps = 0;
  car: Body = newBody();
  riders: Rider[];
  events: SimEvent[] = [];
  telemetry: TelemetrySample[] = [];

  /** 5Hz ローパス後の G（乗客の座席座標） */
  filtered = { gz: 1, gy: 0, gx: 0 };
  peak = { speed: 0, gzMax: 1, gzMin: 1, gyAbs: 0 };

  private over = { wheel: 0, left: 0, right: 0 };
  private prevV = 0;
  private lastRollbackLog = -Infinity;
  private restTime = 0;
  private restReported = false;
  private lapStart = 0;
  private telemetryClock = 0;

  constructor(track: Track, settings: SimSettings) {
    this.track = track;
    this.settings = settings;
    this.physics = createPhysics(track, { ...physicsFor(settings), allowRollback: true });
    this.ride = this.physics.createState();
    this.riders = [
      { id: 'left', label: '左の席', seatX: 0.4, status: 'seated', body: newBody(), glocTime: 0, recoverTime: 0, unconscious: false },
      { id: 'right', label: '右の席', seatX: -0.4, status: 'seated', body: newBody(), glocTime: 0, recoverTime: 0, unconscious: false },
    ];
    this.placeOnTrack();
  }

  start() {
    if (this.status !== 'ready') return;
    this.status = 'running';
    this.lapStart = this.time;
    this.log('info', '発車しました');
  }

  get onTrack() {
    return this.status === 'ready' || this.status === 'running';
  }

  /** 視界の暗さ（0〜1）：高い G で暗く（グレーアウト）、強い負の G で赤く（レッドアウト） */
  get vision() {
    const r = this.riders[0];
    if (r.status !== 'seated') return { grey: 0, red: 0 };
    if (r.unconscious) return { grey: 1, red: 0 };
    return {
      grey: THREE.MathUtils.clamp((this.filtered.gz - 3) / 2, 0, 0.9),
      red: THREE.MathUtils.clamp((-this.filtered.gz - 1.5) / 1.5, 0, 0.7),
    };
  }

  step(dt: number) {
    if (this.status === 'ready') return;
    this.time += dt;

    if (this.onTrack) this.stepOnTrack(dt);
    else this.stepOffTrack(dt);

    for (const r of this.riders) {
      if (r.status === 'ejected' && integrateBody(r.body, dt, 0.25)) {
        r.status = 'landed';
        r.impactSpeed = r.body.vel.length();
        const p = r.body.pos;
        this.log('fail', `${r.label}の乗客が地面に落ちました（落下地点 x ${p.x.toFixed(0)}m, z ${p.z.toFixed(0)}m）`);
      }
    }

    this.telemetryClock += dt;
    if (this.telemetryClock >= 0.05) {
      this.telemetryClock = 0;
      this.telemetry.push({ t: this.time, v: this.onTrack ? this.ride.v : this.car.vel.length(), gz: this.filtered.gz, gy: this.filtered.gy });
      if (this.telemetry.length > 400) this.telemetry.shift();
    }
  }

  private stepOnTrack(dt: number) {
    const prevS = this.ride.s;
    this.physics.step(this.ride, dt);

    // 1周の判定（前向きに駅を通過）
    if (this.ride.v > 0 && prevS > this.track.length * 0.9 && this.ride.s < this.track.length * 0.1) {
      this.laps++;
      this.log('info', `${this.laps}周目を完了しました（${(this.time - this.lapStart).toFixed(1)}秒）`);
      this.lapStart = this.time;
    }

    // 5Hz ローパス
    const k = dt / (1 / (2 * Math.PI * 5) + dt);
    this.filtered.gz += k * (this.ride.g.z - this.filtered.gz);
    this.filtered.gy += k * (this.ride.g.y - this.filtered.gy);
    this.filtered.gx += k * (this.ride.g.x - this.filtered.gx);
    const { gz, gy } = this.filtered;
    this.peak.speed = Math.max(this.peak.speed, Math.abs(this.ride.v));
    this.peak.gzMax = Math.max(this.peak.gzMax, gz);
    this.peak.gzMin = Math.min(this.peak.gzMin, gz);
    this.peak.gyAbs = Math.max(this.peak.gyAbs, Math.abs(gy));

    this.placeOnTrack();
    const at = `${this.ride.s.toFixed(0)}m 地点・${(Math.abs(this.ride.v) * 3.6).toFixed(0)}km/h`;

    // 脱線
    const W = WHEEL_LIMITS;
    const wheelOver = gz > W.gzMax || gz < W.gzMin || Math.abs(gy) > W.gyAbs;
    this.over.wheel = wheelOver ? this.over.wheel + dt : 0;
    if (this.over.wheel > SUSTAIN) {
      const why =
        gz > W.gzMax
          ? `車輪にかかる上下G ${gz.toFixed(1)} が限界 ${W.gzMax} を超えました`
          : gz < W.gzMin
            ? `車両を浮かせる力（上下G ${gz.toFixed(1)}）が補助輪の限界 ${W.gzMin} を超えました`
            : `横G ${gy.toFixed(1)} が横の補助輪の限界 ±${W.gyAbs} を超えました`;
      this.derail(why, at);
      return;
    }

    // 投げ出し
    const R = RESTRAINTS[this.settings.restraint];
    for (const r of this.riders) {
      if (r.status !== 'seated') continue;
      const exceeded = gz < R.gzMin || Math.abs(gy) > R.gyAbs;
      this.over[r.id] = exceeded ? this.over[r.id] + dt : 0;
      if (this.over[r.id] > SUSTAIN) {
        const why =
          gz < R.gzMin
            ? `体が浮く力（上下G ${gz.toFixed(1)}）が${R.label}の限界 ${R.gzMin} を超えました`
            : `横G ${gy.toFixed(1)} が${R.label}の限界 ±${R.gyAbs} を超えました`;
        this.eject(r, why, at);
      }
      this.updateConsciousness(r, gz, dt);
    }

    // 立ち往生：前に進んでいた列車が、重力区間で向きを変えて後ろへ転がり始めた
    if (this.ride.zone === 'free' && this.prevV > 0 && this.ride.v <= 0 && this.time - this.lastRollbackLog > 10) {
      this.lastRollbackLog = this.time;
      this.log('warn', `登り切れずに止まり、後ろへ転がり戻り始めました（${this.ride.s.toFixed(0)}m 地点）`);
    }
    this.prevV = this.ride.v;
    // 完全に止まった
    this.restTime = this.ride.zone === 'free' && Math.abs(this.ride.v) < 0.05 ? this.restTime + dt : 0;
    if (this.restTime > 3 && !this.restReported) {
      this.restReported = true;
      this.log('warn', `コースの途中（${this.ride.s.toFixed(0)}m 地点）で完全に止まりました`);
    }
    if (Math.abs(this.ride.v) > 1) this.restReported = false;
  }

  private stepOffTrack(dt: number) {
    if (integrateBody(this.car, dt, 0.4)) {
      this.log('fail', `車両が地面に落ちました（${(this.car.vel.length() * 3.6).toFixed(0)}km/h で接地）`);
      // 座ったままの乗客は衝撃で投げ出される
      for (const r of this.riders) if (r.status === 'seated') this.eject(r, '地面に落ちた衝撃で投げ出されました', '');
    }
    if (this.car.resting && this.status === 'derailed') {
      this.status = 'wrecked';
      this.log('info', '車両が止まりました');
    }
    for (const r of this.riders) if (r.status === 'seated') this.seatPose(r);
  }

  private derail(why: string, at: string) {
    this.status = 'derailed';
    const fr = this.track.at(this.ride.s);
    const { gz, gy } = this.filtered;
    // 進行方向の速度に、外へ飛び出す向きの速度を足す
    this.car.vel.copy(fr.tan).multiplyScalar(this.ride.v);
    if (gz < WHEEL_LIMITS.gzMin) this.car.vel.addScaledVector(fr.nor, 3);
    if (Math.abs(gy) > WHEEL_LIMITS.gyAbs) this.car.vel.addScaledVector(fr.bin, 3 * Math.sign(gy));
    this.car.spin.copy(fr.tan).multiplyScalar(2 * Math.sign(gy || 1)).addScaledVector(fr.bin, 1.2);
    this.log('fail', `脱線しました（${at}）：${why}`);
  }

  private eject(r: Rider, why: string, at: string) {
    r.status = 'ejected';
    const carVel = this.onTrack ? tmpV.copy(this.track.at(this.ride.s).tan).multiplyScalar(this.ride.v) : tmpV.copy(this.car.vel);
    r.body.vel.copy(carVel);
    if (this.onTrack) {
      const fr = this.track.at(this.ride.s);
      const { gz, gy } = this.filtered;
      if (gz < 0) r.body.vel.addScaledVector(fr.nor, 2 + -gz);
      if (Math.abs(gy) > 0.3) r.body.vel.addScaledVector(fr.bin, (1 + Math.abs(gy)) * Math.sign(gy));
      r.body.spin.set(1.5 * Math.sign(gy || 1), 0.8, 2.2);
    } else {
      r.body.vel.y += 2;
      r.body.spin.set(3, 1, 2);
    }
    this.log('fail', at ? `${r.label}の乗客が投げ出されました（${at}）：${why}` : `${r.label}の乗客：${why}`);
  }

  private updateConsciousness(r: Rider, gz: number, dt: number) {
    const B = BODY_LIMITS;
    if (!r.unconscious) {
      r.glocTime = gz > B.glocGz ? r.glocTime + dt : 0;
      if (r.glocTime > B.glocSeconds) {
        r.unconscious = true;
        r.recoverTime = 0;
        this.log('warn', `${r.label}の乗客が意識を失いました（上下G ${B.glocGz} 以上が ${B.glocSeconds} 秒続きました）`);
      }
    } else {
      r.recoverTime = gz < B.recoverGz ? r.recoverTime + dt : 0;
      if (r.recoverTime > B.recoverSeconds) {
        r.unconscious = false;
        r.glocTime = 0;
        this.log('info', `${r.label}の乗客が意識を取り戻しました`);
      }
    }
  }

  /** 線路上の車両と、座っている乗客の位置・向きを更新する */
  private placeOnTrack() {
    const fr = this.track.at(this.ride.s);
    this.car.pos.copy(fr.pos).addScaledVector(fr.nor, 0.3);
    this.car.quat.setFromRotationMatrix(basis.makeBasis(fr.bin.clone().negate(), fr.nor, fr.tan));
    for (const r of this.riders) if (r.status === 'seated') this.seatPose(r);
  }

  private seatPose(r: Rider) {
    r.body.pos.set(r.seatX, 0.55, 0).applyQuaternion(this.car.quat).add(this.car.pos);
    r.body.quat.copy(this.car.quat);
  }

  private log(kind: SimEvent['kind'], text: string) {
    this.events.push({ t: this.time, kind, text });
  }
}

export function createSim(design: CourseDesign, settings: SimSettings) {
  const track = buildSimTrack(design, settings);
  return new CoasterSim(track, settings);
}
