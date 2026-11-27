import * as THREE from 'three';
import type { Track, Zone } from '../coasterTrack';
import type { CoasterSim, Rider } from './simEngine';

export type CameraMode = 'rider' | 'chase' | 'overview';

const ZONE_COLORS: Record<Zone, number> = {
  free: 0x8b6914,
  station: 0x3a7bd5,
  lift: 0x3d434a,
  trim: 0xe0a030,
  brake: 0xc0392b,
  launch: 0xff6600,
};

const UP = new THREE.Vector3(0, 1, 0);

function disposeTree(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

function makePassenger(shirt: number) {
  const g = new THREE.Group();
  const shirtMat = new THREE.MeshStandardMaterial({ color: shirt });
  const skin = new THREE.MeshStandardMaterial({ color: 0xffcc99 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.55, 0.28), shirtMat);
  body.position.y = 0.0;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), skin);
  head.position.y = 0.45;
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.14, 0.5), new THREE.MeshStandardMaterial({ color: 0x2b3440 }));
  legs.position.set(0, -0.25, 0.2);
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.45, 0.1), shirtMat);
  armL.position.set(0.26, 0.2, 0.05);
  armL.rotation.z = -0.5;
  const armR = armL.clone();
  armR.position.x = -0.26;
  armR.rotation.z = 0.5;
  g.add(body, head, legs, armL, armR);
  return g;
}

export class SimScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1200);

  /** マウス・タッチでの視点操作（乗客視点では首振り、その他では周回） */
  look = { yaw: 0, pitch: 0 };
  // angle = π/2 で +z 側（エディターの下側）から見る。エディターと同じ向きになる
  orbit = { angle: Math.PI / 2, elevation: 0.55 };

  private trackGroup: THREE.Group | null = null;
  private cart = new THREE.Group();
  private passengers: THREE.Group[];
  private markers = new THREE.Group();
  private markedRiders = new Set<string>();
  private resizeObserver: ResizeObserver;
  private camPos = new THREE.Vector3(0, 90, 150);
  private camTarget = new THREE.Vector3(0, 5, -20);
  private center = new THREE.Vector3(0, 5, -20);
  private radius = 230;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';

    this.scene.background = new THREE.Color(0x9fcbe3);
    this.scene.fog = new THREE.FogExp2(0x9fcbe3, 0.0035);
    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a6b3a, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(120, 200, 80);
    this.scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1600, 1600),
      new THREE.MeshStandardMaterial({ color: 0x5c8a4a, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    // 車両
    const red = new THREE.MeshStandardMaterial({ color: 0xd8342c, metalness: 0.3, roughness: 0.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x222831 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.4, 2.2), red);
    body.position.y = -0.2;
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 0.3), red);
    nose.position.set(0, 0.05, 1.1);
    const seatBack = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.6, 0.12), dark);
    seatBack.position.set(0, 0.3, -0.45);
    this.cart.add(body, nose, seatBack);
    this.scene.add(this.cart);

    this.passengers = [makePassenger(0x2f6fd1), makePassenger(0x2fa36b)];
    this.passengers.forEach((p) => this.scene.add(p));
    this.scene.add(this.markers);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 線路のメッシュを作り直す */
  setTrack(track: Track) {
    if (this.trackGroup) {
      this.scene.remove(this.trackGroup);
      disposeTree(this.trackGroup);
    }
    this.clearMarkers();
    const g = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0xaab4bd, metalness: 0.8, roughness: 0.3 });
    const samples = track.samples;

    g.add(new THREE.Mesh(new THREE.TubeGeometry(track.curve, Math.round(track.length * 2), 0.08, 6, true), steel));

    const left: THREE.Vector3[] = [];
    const right: THREE.Vector3[] = [];
    for (let i = 0; i < samples.length; i += 2) {
      const { pos, bin } = samples[i];
      left.push(pos.clone().addScaledVector(bin, -0.5));
      right.push(pos.clone().addScaledVector(bin, 0.5));
    }
    for (const pts of [left, right]) {
      g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), pts.length * 2, 0.07, 5, true), steel));
    }

    // 枕木：区間ごとに色分け（駅 = 青、巻き上げ = 黒、トリム = 黄、ブレーキ = 赤）
    const tieStep = 3;
    const tieCount = Math.ceil(samples.length / tieStep);
    const ties = new THREE.InstancedMesh(new THREE.BoxGeometry(1.4, 0.1, 0.25), new THREE.MeshStandardMaterial(), tieCount);
    const m = new THREE.Matrix4();
    const back = new THREE.Vector3();
    const color = new THREE.Color();
    for (let k = 0; k < tieCount; k++) {
      const p = samples[k * tieStep];
      m.makeBasis(p.bin, p.nor, back.copy(p.tan).negate()).setPosition(p.pos);
      ties.setMatrixAt(k, m);
      ties.setColorAt(k, color.setHex(ZONE_COLORS[track.at(p.s).zone]));
    }
    g.add(ties);

    // 支柱：真下に別の線路が通る所には立てない
    const minGap = Math.round(20 / track.sampleStep);
    const hasTrackBelow = (i: number) => {
      const p = samples[i].pos;
      for (let j = 0; j < samples.length; j += 2) {
        const d = Math.abs(i - j);
        if (Math.min(d, samples.length - d) < minGap) continue;
        const q = samples[j].pos;
        if (q.y < p.y && Math.hypot(q.x - p.x, q.z - p.z) < 1.5) return true;
      }
      return false;
    };
    const poleIdx: number[] = [];
    for (let i = 0; i < samples.length; i += 16) if (samples[i].pos.y > 1.5 && !hasTrackBelow(i)) poleIdx.push(i);
    const poles = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.08, 0.11, 1, 6),
      new THREE.MeshStandardMaterial({ color: 0x8d969e }),
      Math.max(1, poleIdx.length),
    );
    poleIdx.forEach((i, k) => {
      const p = samples[i].pos;
      m.makeScale(1, p.y, 1).setPosition(p.x, p.y / 2, p.z);
      poles.setMatrixAt(k, m);
    });
    poles.count = poleIdx.length;
    g.add(poles);

    // ループ区間：通常支柱を立てずにリング状の骨組みを追加
    if (track.loopRanges && track.loopRanges.length > 0) {
      const ringMat = new THREE.MeshStandardMaterial({ color: 0x8d969e });
      for (const lr of track.loopRanges) {
        // ループ区間のサンプルを収集
        const loopSamples = samples.filter((s) => {
          const u = s.u;
          return lr.uFrom <= lr.uTo ? u >= lr.uFrom && u < lr.uTo : u >= lr.uFrom || u < lr.uTo;
        });
        if (loopSamples.length < 4) continue;

        // ループの中心点と半径を推定（頂上サンプルと入口サンプルの中点）
        const topSample = loopSamples.reduce((a, b) => (a.pos.y > b.pos.y ? a : b));
        const entrySample = loopSamples[0];
        const center = new THREE.Vector3(
          (topSample.pos.x + entrySample.pos.x) / 2,
          (topSample.pos.y + entrySample.pos.y) / 2,
          (topSample.pos.z + entrySample.pos.z) / 2,
        );
        const radius = topSample.pos.distanceTo(entrySample.pos) / 2;

        // 両脇に支柱を2本ずつ立てる（入口付近と出口付近）
        const supportPositions = [
          loopSamples[Math.floor(loopSamples.length * 0.1)],
          loopSamples[Math.floor(loopSamples.length * 0.9)],
        ];
        for (const sp of supportPositions) {
          if (sp.pos.y > 1.5) {
            const poleH = sp.pos.y;
            const pole = new THREE.Mesh(
              new THREE.CylinderGeometry(0.1, 0.14, poleH, 6),
              ringMat,
            );
            pole.position.set(sp.pos.x, poleH / 2, sp.pos.z);
            g.add(pole);
          }
        }

        // ループの横にアーチ（斜め支柱）を追加
        const archCount = 4;
        for (let ai = 0; ai < archCount; ai++) {
          const t = (ai + 0.5) / archCount;
          const sp = loopSamples[Math.floor(t * loopSamples.length)];
          if (sp.pos.y < 2) continue;
          // 軌道位置から地面への傾斜支柱
          const offset = sp.bin.clone().multiplyScalar(radius * 0.6);
          for (const sign of [1, -1]) {
            const groundPt = sp.pos.clone().addScaledVector(sp.bin, sign * radius * 0.6);
            groundPt.y = 0;
            const archLen = sp.pos.distanceTo(groundPt);
            const midPt = sp.pos.clone().add(groundPt).multiplyScalar(0.5);
            const arch = new THREE.Mesh(
              new THREE.CylinderGeometry(0.07, 0.07, archLen, 5),
              ringMat,
            );
            arch.position.copy(midPt);
            const up2 = new THREE.Vector3(0, 1, 0);
            const dir2 = groundPt.clone().sub(sp.pos).normalize();
            arch.quaternion.setFromUnitVectors(up2, dir2);
            g.add(arch);
          }
        }
      }
    }

    this.trackGroup = g;
    this.scene.add(g);

    // 全体視点の中心と半径をコースに合わせる
    const box = new THREE.Box3();
    samples.forEach((p) => box.expandByPoint(p.pos));
    box.getCenter(this.center);
    this.center.y = 5;
    this.radius = Math.max(80, box.getSize(new THREE.Vector3()).length() * 0.75);
  }

  /** 落下地点の目印を消す（最初からやり直すとき） */
  clearMarkers() {
    this.markers.children.forEach((c) => disposeTree(c));
    this.markers.clear();
    this.markedRiders.clear();
  }

  update(sim: CoasterSim, mode: CameraMode, dt: number) {
    this.cart.position.copy(sim.car.pos);
    this.cart.quaternion.copy(sim.car.quat);
    sim.riders.forEach((r, i) => {
      const p = this.passengers[i];
      p.position.copy(r.body.pos);
      if (r.status === 'landed' && r.body.resting) {
        // 地面で止まったら、向きだけ残して横たわらせる
        const yaw = new THREE.Euler().setFromQuaternion(r.body.quat, 'YXZ').y;
        p.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, yaw, 0, 'YXZ'));
        p.position.y = 0.2;
      } else {
        p.quaternion.copy(r.body.quat);
      }
      if (r.status === 'landed' && !this.markedRiders.has(r.id)) this.addMarker(r);
    });
    this.updateCamera(sim, mode, dt);
    this.renderer.render(this.scene, this.camera);
  }

  private addMarker(r: Rider) {
    this.markedRiders.add(r.id);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.2, 1.6, 32),
      new THREE.MeshBasicMaterial({ color: 0xe5484d, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(r.body.pos.x, 0.05, r.body.pos.z);
    this.markers.add(ring);
  }

  private updateCamera(sim: CoasterSim, mode: CameraMode, dt: number) {
    const smooth = 1 - Math.exp(-dt * 6);
    const rider = sim.riders[0];

    if (mode === 'rider' && rider.status === 'seated') {
      // 左の席の乗客の目線：カートのローカル z が前、カメラは -z が前なので半回転させる
      const eye = new THREE.Vector3(rider.seatX, 0.85, 0.05).applyQuaternion(sim.car.quat).add(sim.car.pos);
      const q = sim.car.quat
        .clone()
        .multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.PI + this.look.yaw))
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.look.pitch));
      this.camera.position.copy(eye);
      this.camera.quaternion.copy(q);
      this.camPos.copy(eye);
      this.camTarget.copy(sim.car.pos);
      return;
    }

    if (mode === 'overview') {
      const a = this.orbit.angle;
      const e = this.orbit.elevation;
      const goal = new THREE.Vector3(
        this.center.x + Math.cos(a) * Math.cos(e) * this.radius,
        this.center.y + Math.sin(e) * this.radius,
        this.center.z + Math.sin(a) * Math.cos(e) * this.radius,
      );
      this.camPos.lerp(goal, smooth);
      this.camTarget.lerp(this.center, smooth);
    } else {
      // 追いかけ視点（乗客視点で乗客が投げ出された後は、その乗客を追う）
      const followRider = mode === 'rider';
      const target = followRider ? rider.body.pos : sim.car.pos;
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(sim.car.quat);
      forward.y = 0;
      if (forward.lengthSq() < 1e-4) forward.set(0, 0, 1);
      forward.normalize();
      // 後ろ 9m・上 3〜6m から。ドラッグで周りを回り込める
      const offset = forward
        .multiplyScalar(-9)
        .add(new THREE.Vector3(0, 3 + this.orbit.elevation * 5, 0))
        .applyAxisAngle(UP, this.look.yaw);
      this.camPos.lerp(target.clone().add(offset), followRider ? smooth * 0.6 : smooth);
      this.camTarget.lerp(target, Math.min(1, smooth * 1.5));
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
  }

  dispose() {
    this.resizeObserver.disconnect();
    if (this.trackGroup) disposeTree(this.trackGroup);
    disposeTree(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
