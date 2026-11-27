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
export const BODY_LIMITS = { glocGz: 4.5, glocSeconds: 1.5, recoverGz: 2, recoverSeconds: 3 };

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
  seatOffset: THREE.Vector3; // 座席取り付けオフセット (カートローカル: x=左, y=上, z=前)
  status: RiderStatus;
  body: Body;
  glocTime: number;
  recoverTime: number;
  unconscious: boolean;
  impactSpeed?: number; // 地面に落ちたときの速さ [m/s]
  g: RiderGForce; // 乗客が感じる G（座席の向きに分解）
  /** 乗客の体の位置の2階微分テーブル（線路建設時に事前計算） */
  d2qTable: THREE.Vector3[];
};

export type TrainStatus = 'ready' | 'running' | 'derailed' | 'wrecked';

export type SimEventCode =
  | 'start'
  | 'lap'
  | 'eject'
  | 'land'
  | 'derail'
  | 'car-land'
  | 'rollback'
  | 'rest'
  | 'gloc'
  | 'recover'
  | 'launch-g';

export type EjectCause = 'gz' | 'gy' | 'impact';

export type SimEvent =
  | { t: number; kind: 'info' | 'warn' | 'fail'; code: Exclude<SimEventCode, 'eject'>; text: string }
  | { t: number; kind: 'info' | 'warn' | 'fail'; code: 'eject'; cause: EjectCause; text: string };

export type TelemetrySample = { t: number; v: number; gz: number; gy: number; gzLeft: number; gzRight: number };

/** 乗客ごとの G（座席の上下・横・前後に分解） */
export type RiderGForce = { gz: number; gy: number; gx: number };

/**
 * 距離 s テーブルとして、乗客の位置オフセットによる曲率補正係数を事前計算する。
 *
 * 曲率ベクトル κ = curv（大きさ = 1/R）の方向に対して、
 * 座席が Δr だけずれていると、乗客の有効半径は R ± Δr となる。
 * 乗客の遠心加速度 = v² * κ / (1 + κ * Δr_κ) ≈ v² * κ * (1 - κ * Δr_κ)
 * （Δr_κ = 曲率方向への射影、小さい場合は近似が成立）
 *
 * テーブルには「座席の曲率方向オフセット Δr_κ」を格納する。
 */
function buildRiderDerivTable(
  track: { sampleStep: number; samples: { curv: THREE.Vector3; nor: THREE.Vector3; bin: THREE.Vector3 }[] },
  seatOffset: THREE.Vector3, // カートローカル: x=左, y=上, z=前
): { d2q: THREE.Vector3[] } {
  // 各サンプル点で、座席ワールド位置の「曲率方向への射影」を計算し
  // それを d²q/ds² の補正として返す。
  // 厳密な d²q/ds² = track_curv + 座席オフセットの曲率方向補正
  const d2q = track.samples.map((p) => {
    // カートローカル (x=左=-bin, y=上=nor) → ワールドオフセット
    const rOffset = new THREE.Vector3()
      .addScaledVector(p.bin, -seatOffset.x)
      .addScaledVector(p.nor, seatOffset.y);

    // 曲率ベクトル κ（方向＝曲率方向、大きさ＝1/R）
    const kappa = p.curv.length();
    if (kappa < 1e-6) {
      // 直線区間：曲率補正なし
      return p.curv.clone();
    }
    // 曲率方向への射影 Δr_κ
    const curvHat = p.curv.clone().divideScalar(kappa);
    const deltaR = rOffset.dot(curvHat);
    // 補正後の曲率: κ / (1 + κ * deltaR) ≈ κ * (1 - κ*deltaR) for small deltaR
    // 乗客の d²q/ds² = 補正後の曲率方向加速度
    const kappaCorrected = kappa / (1 + kappa * deltaR);
    return curvHat.multiplyScalar(kappaCorrected);
  });

  return { d2q };
}

/** 距離 s での乗客が感じる G を計算する（曲率補正を使って安定的に計算） */
function riderGForce(
  s: number,
  v: number,
  aTan: number,
  d2qTable: THREE.Vector3[],
  trackLength: number,
  ds: number,
  samples: { curv: THREE.Vector3; nor: THREE.Vector3; bin: THREE.Vector3; tan: THREE.Vector3 }[],
): RiderGForce {
  const n = d2qTable.length;
  const x = ((((s % trackLength) + trackLength) % trackLength) / ds);
  const i = Math.floor(x) % n;
  const j = (i + 1) % n;
  const w = x - Math.floor(x);

  const riderCurv = d2qTable[i].clone().lerp(d2qTable[j], w);

  const sA = samples[i];
  const sB = samples[j];
  const nor = sA.nor.clone().lerp(sB.nor, w).normalize();
  const bin = sA.bin.clone().lerp(sB.bin, w).normalize();
  const tan = sA.tan.clone().lerp(sB.tan, w).normalize();

  // 乗客の遠心加速度 = riderCurv * v²（曲率方向）
  // 前後加速度の寄与 = tan * aTan
  const G_VAL = 9.81;
  const accel = riderCurv.clone().multiplyScalar(v * v).addScaledVector(tan, aTan);

  // 乗客が感じる力 = (加速度 + 重力) / g
  const f = accel.clone().add(new THREE.Vector3(0, G_VAL, 0)).divideScalar(G_VAL);

  return {
    gz: f.dot(nor),  // 上下（座面方向、+ 座面に押し付けられる）
    gy: f.dot(bin),  // 横（+ 右へ押される）
    gx: f.dot(tan),  // 前後（+ 前向きに押される）
  };
}

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

  /** 5Hz ローパス後の G（左の乗客の座席座標） */
  filtered = { gz: 1, gy: 0, gx: 0 };
  /** 各乗客の 5Hz ローパス後の G */
  filteredRider: RiderGForce[] = [];
  peak = { speed: 0, gzMax: 1, gzMin: 1, gyAbs: 0 };

  private over = { wheel: 0, left: 0, right: 0 };
  private prevV = 0;
  private lastRollbackLog = -Infinity;
  private launchGwarnFired = false;
  private launchGoverTime = 0;
  private restTime = 0;
  private restReported = false;
  private lapStart = 0;
  private telemetryClock = 0;

  constructor(track: Track, settings: SimSettings) {
    this.track = track;
    this.settings = settings;
    this.physics = createPhysics(track, { ...physicsFor(settings), allowRollback: true });
    this.ride = this.physics.createState();

    // 座席取り付けオフセット: x=左, y=上, z=前 (カートローカル座標)
    // o = (±0.4, 0.55, 0): 左の席は x=+0.4、右の席は x=-0.4
    const makeRider = (id: 'left' | 'right', label: string, seatX: number): Rider => {
      const seatOffset = new THREE.Vector3(seatX, 0.55, 0);
      const { d2q: d2qTable } = buildRiderDerivTable(track, seatOffset);
      return { id, label, seatX, seatOffset, status: 'seated', body: newBody(), glocTime: 0, recoverTime: 0, unconscious: false, g: { gz: 1, gy: 0, gx: 0 }, d2qTable };
    };
    this.riders = [
      makeRider('left', '左の席', 0.4),
      makeRider('right', '右の席', -0.4),
    ];
    this.filteredRider = this.riders.map(() => ({ gz: 1, gy: 0, gx: 0 }));
    this.placeOnTrack();
  }

  start() {
    if (this.status !== 'ready') return;
    this.status = 'running';
    this.lapStart = this.time;
    this.log('info', 'start', '発車しました');
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
        this.log('fail', 'land', `${r.label}の乗客が地面に落ちました（落下地点 x ${p.x.toFixed(0)}m, z ${p.z.toFixed(0)}m）`);
      }
    }

    this.telemetryClock += dt;
    if (this.telemetryClock >= 0.05) {
      this.telemetryClock = 0;
      const gzLeft = this.filteredRider[0]?.gz ?? this.filtered.gz;
      const gzRight = this.filteredRider[1]?.gz ?? this.filtered.gz;
      this.telemetry.push({ t: this.time, v: this.onTrack ? this.ride.v : this.car.vel.length(), gz: this.filtered.gz, gy: this.filtered.gy, gzLeft, gzRight });
      if (this.telemetry.length > 400) this.telemetry.shift();
    }
  }

  private stepOnTrack(dt: number) {
    const prevS = this.ride.s;
    this.physics.step(this.ride, dt);

    // 1周の判定（前向きに駅を通過）
    if (this.ride.v > 0 && prevS > this.track.length * 0.9 && this.ride.s < this.track.length * 0.1) {
      this.laps++;
      this.log('info', 'lap', `${this.laps}周目を完了しました（${(this.time - this.lapStart).toFixed(1)}秒）`);
      this.lapStart = this.time;
    }

    // 乗客ごとの G を計算し 5Hz ローパスをかける
    const k = dt / (1 / (2 * Math.PI * 5) + dt);
    for (let ri = 0; ri < this.riders.length; ri++) {
      const r = this.riders[ri];
      if (r.status === 'seated') {
        r.g = riderGForce(this.ride.s, this.ride.v, this.ride.a, r.d2qTable, this.track.length, this.track.sampleStep, this.track.samples);
      }
      this.filteredRider[ri].gz += k * (r.g.gz - this.filteredRider[ri].gz);
      this.filteredRider[ri].gy += k * (r.g.gy - this.filteredRider[ri].gy);
      this.filteredRider[ri].gx += k * (r.g.gx - this.filteredRider[ri].gx);
    }

    // 表示用：左の乗客の G をメインの filtered として使う
    this.filtered.gz = this.filteredRider[0].gz;
    this.filtered.gy = this.filteredRider[0].gy;
    this.filtered.gx = this.filteredRider[0].gx;

    const { gz, gy } = this.filtered;
    this.peak.speed = Math.max(this.peak.speed, Math.abs(this.ride.v));
    this.peak.gzMax = Math.max(this.peak.gzMax, gz);
    this.peak.gzMin = Math.min(this.peak.gzMin, gz);
    this.peak.gyAbs = Math.max(this.peak.gyAbs, Math.abs(gy));

    this.placeOnTrack();
    const at = `${this.ride.s.toFixed(0)}m 地点・${(Math.abs(this.ride.v) * 3.6).toFixed(0)}km/h`;

    // 脱線は線路中心の G（車輪にかかる G）で判定する
    const trackG = this.ride.g; // coasterPhysics が計算した線路中心の G
    const W = WHEEL_LIMITS;
    const wheelOver = trackG.z > W.gzMax || trackG.z < W.gzMin || Math.abs(trackG.y) > W.gyAbs;
    this.over.wheel = wheelOver ? this.over.wheel + dt : 0;
    if (this.over.wheel > SUSTAIN) {
      const why =
        trackG.z > W.gzMax
          ? `車輪にかかる上下G ${trackG.z.toFixed(1)} が限界 ${W.gzMax} を超えました`
          : trackG.z < W.gzMin
            ? `車両を浮かせる力（上下G ${trackG.z.toFixed(1)}）が補助輪の限界 ${W.gzMin} を超えました`
            : `横G ${trackG.y.toFixed(1)} が横の補助輪の限界 ±${W.gyAbs} を超えました`;
      this.derail(why, at);
      return;
    }

    // 投げ出し・意識判定は乗客ごとの G で行う
    const R = RESTRAINTS[this.settings.restraint];
    for (let ri = 0; ri < this.riders.length; ri++) {
      const r = this.riders[ri];
      if (r.status !== 'seated') continue;
      const rg = this.filteredRider[ri];
      const exceeded = rg.gz < R.gzMin || Math.abs(rg.gy) > R.gyAbs;
      this.over[r.id] = exceeded ? this.over[r.id] + dt : 0;
      if (this.over[r.id] > SUSTAIN) {
        const cause: EjectCause = rg.gz < R.gzMin ? 'gz' : 'gy';
        const why =
          rg.gz < R.gzMin
            ? `体が浮く力（上下G ${rg.gz.toFixed(1)}）が${R.label}の限界 ${R.gzMin} を超えました`
            : `横G ${rg.gy.toFixed(1)} が${R.label}の限界 ±${R.gyAbs} を超えました`;
        this.eject(r, cause, why, at);
      }
      // 意識喪失の判定には非フィルタG を使う（glocSeconds自体が時間平均の役割を果たす）
      this.updateConsciousness(r, r.g.gz, dt);
    }

    // 立ち往生：前に進んでいた列車が、重力区間で向きを変えて後ろへ転がり始めた
    if (this.ride.zone === 'free' && this.prevV > 0 && this.ride.v <= 0 && this.time - this.lastRollbackLog > 10) {
      this.lastRollbackLog = this.time;
      this.log('warn', 'rollback', `登り切れずに止まり、後ろへ転がり戻り始めました（${this.ride.s.toFixed(0)}m 地点）`);
    }
    this.prevV = this.ride.v;

    // 前後G警告（発射時）
    if (this.ride.launchPhase === 'firing') {
      if (Math.abs(this.ride.g.x) > 2.5) {
        this.launchGoverTime += dt;
        if (this.launchGoverTime > SUSTAIN && !this.launchGwarnFired) {
          this.launchGwarnFired = true;
          this.log('warn', 'launch-g', `強い加速で頭が後ろへ振られます（前後G ${Math.abs(this.ride.g.x).toFixed(1)}）`);
        }
      } else {
        this.launchGoverTime = 0;
      }
    } else {
      this.launchGoverTime = 0;
      if (this.ride.launchPhase === 'none' && this.launchGwarnFired) {
        this.launchGwarnFired = false;
      }
    }
    // 完全に止まった
    this.restTime = this.ride.zone === 'free' && Math.abs(this.ride.v) < 0.05 ? this.restTime + dt : 0;
    if (this.restTime > 3 && !this.restReported) {
      this.restReported = true;
      this.log('warn', 'rest', `コースの途中（${this.ride.s.toFixed(0)}m 地点）で完全に止まりました`);
    }
    if (Math.abs(this.ride.v) > 1) this.restReported = false;
  }

  private stepOffTrack(dt: number) {
    if (integrateBody(this.car, dt, 0.4)) {
      this.log('fail', 'car-land', `車両が地面に落ちました（${(this.car.vel.length() * 3.6).toFixed(0)}km/h で接地）`);
      // 座ったままの乗客は衝撃で投げ出される
      for (const r of this.riders) if (r.status === 'seated') this.eject(r, 'impact', '地面に落ちた衝撃で投げ出されました', '');
    }
    if (this.car.resting && this.status === 'derailed') {
      this.status = 'wrecked';
      this.log('info', 'rest', '車両が止まりました');
    }
    for (const r of this.riders) if (r.status === 'seated') this.seatPose(r);
  }

  private derail(why: string, at: string) {
    this.status = 'derailed';
    const fr = this.track.at(this.ride.s);
    // 脱線方向は線路中心の G（車輪にかかる G）で決める
    const tgz = this.ride.g.z;
    const tgy = this.ride.g.y;
    this.car.vel.copy(fr.tan).multiplyScalar(this.ride.v);
    if (tgz < WHEEL_LIMITS.gzMin) this.car.vel.addScaledVector(fr.nor, 3);
    if (Math.abs(tgy) > WHEEL_LIMITS.gyAbs) this.car.vel.addScaledVector(fr.bin, 3 * Math.sign(tgy));
    this.car.spin.copy(fr.tan).multiplyScalar(2 * Math.sign(tgy || 1)).addScaledVector(fr.bin, 1.2);
    this.log('fail', 'derail', `脱線しました（${at}）：${why}`);
  }

  private eject(r: Rider, cause: EjectCause, why: string, at: string) {
    r.status = 'ejected';
    const carVel = this.onTrack ? tmpV.copy(this.track.at(this.ride.s).tan).multiplyScalar(this.ride.v) : tmpV.copy(this.car.vel);
    r.body.vel.copy(carVel);
    if (this.onTrack) {
      const fr = this.track.at(this.ride.s);
      const rg = r.g; // 乗客自身の G で投げ出し方向を決める
      if (rg.gz < 0) r.body.vel.addScaledVector(fr.nor, 2 + -rg.gz);
      if (Math.abs(rg.gy) > 0.3) r.body.vel.addScaledVector(fr.bin, (1 + Math.abs(rg.gy)) * Math.sign(rg.gy)); // gy: 右正→右(+bin)に飛ぶ
      r.body.spin.set(1.5 * Math.sign(rg.gy || 1), 0.8, 2.2);
    } else {
      r.body.vel.y += 2;
      r.body.spin.set(3, 1, 2);
    }
    this.logEject('fail', cause, at ? `${r.label}の乗客が投げ出されました（${at}）：${why}` : `${r.label}の乗客：${why}`);
  }

  private updateConsciousness(r: Rider, gz: number, dt: number) {
    const B = BODY_LIMITS;
    if (!r.unconscious) {
      // 閾値を超えたらカウント増加、下回ったら2倍速でカウント減少（短い揺らぎでリセットしない）
      r.glocTime = gz > B.glocGz ? r.glocTime + dt : Math.max(0, r.glocTime - 2 * dt);
      if (r.glocTime > B.glocSeconds) {
        r.unconscious = true;
        r.recoverTime = 0;
        this.log('warn', 'gloc', `${r.label}の乗客が意識を失いました（上下G ${B.glocGz} 以上が ${B.glocSeconds} 秒続きました）`);
      }
    } else {
      r.recoverTime = gz < B.recoverGz ? r.recoverTime + dt : 0;
      if (r.recoverTime > B.recoverSeconds) {
        r.unconscious = false;
        r.glocTime = 0;
        this.log('info', 'recover', `${r.label}の乗客が意識を取り戻しました`);
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

  private log(kind: SimEvent['kind'], code: Exclude<SimEventCode, 'eject'>, text: string) {
    this.events.push({ t: this.time, kind, code, text });
  }

  private logEject(kind: SimEvent['kind'], cause: EjectCause, text: string) {
    this.events.push({ t: this.time, kind, code: 'eject', cause, text });
  }
}

export function createSim(design: CourseDesign, settings: SimSettings) {
  const track = buildSimTrack(design, settings);
  return new CoasterSim(track, settings);
}
