import * as THREE from 'three';
import type { Track, Zone } from './coasterTrack';

/**
 * 速度計算（角度ベース）＋ 乗客が感じる G の計算
 *
 * レール方向の加速度 a = -g·sinθ（重力） - μ·g·N（転がり抵抗） - k·v²（空気抵抗）
 *   N は車輪がレールに押し付けられる力（G）。谷底で強く、丘の頂上で弱くなる。
 *
 * 区間ごとの機械の役割
 *   station : タイヤ駆動で一定速度に合わせる
 *   lift    : チェーンが最低速度を保証する（遅ければ引き上げる）
 *   trim    : 速すぎるときだけ設計速度まで落とす（気温などで速さがばらついても後半の G を一定にする）
 *   brake   : 目標速度まで一定の減速度でブレーキ
 *   free    : 重力だけで走る（ここで止まったら設計ミス）
 */

export type PhysicsParams = {
  gravity: number;
  rollingFriction: number; // μ
  airDrag: number; // k [1/m]
  stationSpeed: number; // [m/s]
  stationAccel: number; // 駅での加減速 [m/s²]
  liftSpeed: number; // [m/s]
  liftAccel: number; // チェーンが噛み合うときの加速 [m/s²]
  trimSpeed: number; // トリムブレーキの上限速度 [m/s]（ゾーンに speed がないときの既定値）
  brakeTargetSpeed: number; // [m/s]
  brakeDecel: number; // [m/s²]
  subSteps: number;
  /**
   * true にすると、止まった列車がそのまま後ろへ転がり戻る（シミュレーター用）。
   * false（既定）では、重力区間で止まりかけたら stalled を立てて微速で押し出す（設計検証用）。
   */
  allowRollback: boolean;
};

export const DEFAULT_PHYSICS: PhysicsParams = {
  gravity: 9.81,
  rollingFriction: 0.012,
  airDrag: 0.0006,
  stationSpeed: 2,
  stationAccel: 1.5,
  liftSpeed: 4,
  liftAccel: 1.0,
  trimSpeed: 15, // 54 km/h（標準条件での丘 1 頂上の速度）
  brakeTargetSpeed: 3,
  brakeDecel: 4.0, // ≈ 0.41 G
  subSteps: 4,
  allowRollback: false,
};

export type GForce = {
  /** 上下（+ 座面に押し付けられる / − 浮く） */
  z: number;
  /** 左右（+ 右へ押される） */
  y: number;
  /** 前後（+ 背もたれに押される） */
  x: number;
};

export type RideState = {
  s: number;
  v: number;
  a: number; // レール方向の加速度 [m/s²]
  zone: Zone;
  g: GForce;
  stalled: boolean; // free 区間で止まりかけた（＝コース設計の不具合）
};

export function createPhysics(track: Track, params: Partial<PhysicsParams> = {}) {
  const p: PhysicsParams = { ...DEFAULT_PHYSICS, ...params };
  const upG = new THREE.Vector3(0, p.gravity, 0);
  const f = new THREE.Vector3();

  /** 乗客が感じる力 = (列車の加速度 − 重力) / g を、座席の向きに分解 */
  function gForce(s: number, v: number, aTan: number): GForce {
    const fr = track.at(s);
    f.copy(fr.curv).multiplyScalar(v * v).addScaledVector(fr.tan, aTan).add(upG).divideScalar(p.gravity);
    return { z: f.dot(fr.nor), y: f.dot(fr.bin), x: f.dot(fr.tan) };
  }

  function step(state: RideState, deltaSec: number) {
    const dt = Math.min(deltaSec, 1 / 30);
    const h = dt / p.subSteps;

    for (let i = 0; i < p.subSteps; i++) {
      const fr = track.at(state.s);
      const sin = THREE.MathUtils.clamp(fr.tan.y, -1, 1);
      const normalG = Math.max(0, gForce(state.s, state.v, 0).z);
      const dir = Math.sign(state.v);

      // 重力・転がり抵抗・空気抵抗（抵抗は進んでいる向きと逆にかかる）
      const gravityA = -p.gravity * sin;
      const frictionA = p.rollingFriction * p.gravity * normalG;
      let a = gravityA - dir * frictionA - dir * p.airDrag * state.v * state.v;
      // 止まっていて、重力が摩擦に勝てないときは止まったまま（静止摩擦）
      if (Math.abs(state.v) < 1e-3 && Math.abs(gravityA) <= frictionA) a = -state.v / h;

      switch (fr.zone) {
        case 'station': {
          const diff = p.stationSpeed - state.v;
          // 発車はゆっくり、速く入ってきたときはブレーキと同じ強さで止める
          a = THREE.MathUtils.clamp(diff / h, -p.brakeDecel, p.stationAccel);
          break;
        }
        case 'lift':
          // 逆走防止装置（アンチロールバック）で後ろへは下がらない
          if (state.v < 0) state.v = 0;
          // チェーンは列車を liftSpeed で引く。噛み合うときは liftAccel 以下でなめらかに加速
          if (state.v + a * h < p.liftSpeed) a = Math.min((p.liftSpeed - state.v) / h, p.liftAccel);
          break;
        case 'trim': {
          const target = fr.zoneSpeed ?? p.trimSpeed;
          if (state.v > target) a = Math.max((target - state.v) / h, -p.brakeDecel);
          else if (state.v < -target) a = Math.min((-target - state.v) / h, p.brakeDecel); // 逆走時も効く
          break;
        }
        case 'brake':
          if (state.v > p.brakeTargetSpeed) a = Math.max(a, 0) - p.brakeDecel;
          else if (state.v < -p.brakeTargetSpeed) a = Math.min(a, 0) + p.brakeDecel;
          break;
      }

      state.v += a * h;

      if (p.allowRollback) {
        state.stalled = fr.zone === 'free' && Math.abs(state.v) < 0.3;
      } else {
        // 重力区間で止まりかけた場合：検出用のフラグを立て、逆走させずに微速で押し出す
        state.v = Math.max(0, state.v);
        state.stalled = fr.zone === 'free' && state.v < 0.5;
        if (state.stalled) state.v = 0.5;
      }

      state.a = a;
      state.zone = fr.zone;
      state.s = (((state.s + state.v * h) % track.length) + track.length) % track.length;
    }
    state.g = gForce(state.s, state.v, state.a);
  }

  function createState(startS = 0): RideState {
    return { s: startS, v: p.stationSpeed, a: 0, zone: 'station', g: { x: 0, y: 0, z: 1 }, stalled: false };
  }

  return { params: p, step, gForce, createState };
}

/**
 * 標準条件で1周走らせ、その速度に合わせて線路にバンク角を付ける。
 * 実物と同じく「設計速度」で一度だけ決めて固定する（線路を作った直後に1回呼ぶ）。
 */
export function bankForDesignSpeed(track: Track, params: Partial<PhysicsParams> = {}) {
  const ph = createPhysics(track, params);
  const st = ph.createState();
  const n = track.samples.length;
  const table = new Array<number>(n).fill(0);
  let laps = 0;
  let prev = st.s;
  for (let k = 0; k < 60 * 900 && laps < 2; k++) {
    ph.step(st, 1 / 60);
    if (st.s < prev) laps++;
    prev = st.s;
    if (laps === 1) table[Math.floor(st.s / track.sampleStep) % n] = st.v;
  }
  for (let i = 1; i < n * 2; i++) if (!table[i % n]) table[i % n] = table[(i - 1) % n];
  track.applyBanking((s) => table[Math.floor(s / track.sampleStep) % n]);
}
