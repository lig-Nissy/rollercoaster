'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import * as THREE from 'three';
import { buildTrack } from '@/components/coasterTrack';
import { bankForDesignSpeed, createPhysics } from '@/components/coasterPhysics';

const KEY_SPEED = 1.5;

export default function RollerCoaster() {
  const containerRef = useRef<HTMLDivElement>(null);
  const speedSpanRef = useRef<HTMLSpanElement>(null);
  const gSpanRef = useRef<HTMLSpanElement>(null);
  const startScreenRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);

  // State refs (avoid re-renders)
  const startedRef = useRef(false);
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const draggingRef = useRef(false);
  const lastMXRef = useRef(0);
  const lastMYRef = useRef(0);
  const lastTXRef = useRef(0);
  const lastTYRef = useRef(0);
  const keysRef = useRef<Record<string, boolean>>({});
  const animFrameIdRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ---- Renderer ----
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);

    // ---- Camera ----
    const camera = new THREE.PerspectiveCamera(85, window.innerWidth / window.innerHeight, 0.1, 500);
    camera.position.set(0, 90, 150);
    camera.lookAt(0, 5, -20);

    // ---- Scene ----
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = new THREE.FogExp2(0x87ceeb, 0.005);

    // ---- Lights ----
    const dirLight = new THREE.DirectionalLight(0xfffaee, 2.0);
    dirLight.position.set(50, 100, 50);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.far = 300;
    dirLight.shadow.camera.left = -80;
    dirLight.shadow.camera.right = 80;
    dirLight.shadow.camera.top = 80;
    dirLight.shadow.camera.bottom = -80;
    scene.add(dirLight);

    const ambientLight = new THREE.AmbientLight(0x88aaff, 0.6);
    scene.add(ambientLight);

    const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x2d5a1b, 0.5);
    scene.add(hemiLight);

    // ---- Ground ----
    const groundGeo = new THREE.PlaneGeometry(600, 600, 60, 60);
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x4a7c3f });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // ---- Grass ----
    for (let i = 0; i < 800; i++) {
      const grassGeo = new THREE.PlaneGeometry(0.4, 0.8);
      const grassMat = new THREE.MeshLambertMaterial({ color: 0x3a6b2f, side: THREE.DoubleSide });
      const grass = new THREE.Mesh(grassGeo, grassMat);
      grass.position.set(
        (Math.random() - 0.5) * 560,
        0.4,
        (Math.random() - 0.5) * 560
      );
      grass.rotation.y = Math.random() * Math.PI;
      scene.add(grass);
    }

    // ---- Clouds ----
    const cloudPositions = [
      [-40, 60, -80], [20, 55, -100], [80, 65, -60], [-60, 58, -120], [10, 70, -50],
      [60, 62, 40], [-80, 68, 20], [30, 58, 80], [-20, 72, -150], [100, 60, -20],
      [-100, 65, -60], [50, 75, -100], [-50, 58, 60], [0, 70, 100], [70, 62, -130],
    ];
    const cloudSpheres = [
      [0, 0, 0, 2.5], [2, 0.4, 0, 2], [-2, 0.2, 0, 1.8], [0, 1.2, 0, 2], [1, 0.9, 1, 1.5], [-1, 0.8, -1, 1.4],
    ];
    for (const [cx, cy, cz] of cloudPositions) {
      const cloudGroup = new THREE.Group();
      cloudGroup.position.set(cx, cy, cz);
      for (const [sx, sy, sz, sr] of cloudSpheres) {
        const sGeo = new THREE.SphereGeometry(sr, 8, 6);
        const sMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
        const s = new THREE.Mesh(sGeo, sMat);
        s.position.set(sx, sy, sz);
        cloudGroup.add(s);
      }
      scene.add(cloudGroup);
    }

    // ---- Track ----
    // コース形状は coasterTrack.ts、速度と G は coasterPhysics.ts で計算する
    const track = buildTrack();
    bankForDesignSpeed(track); // 設計速度に合わせてバンク角を付ける（横 G をほぼ 0 にする）
    const physics = createPhysics(track);
    const ride = physics.createState();

    const steelMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0.8, roughness: 0.3 });

    // Center tube
    scene.add(new THREE.Mesh(new THREE.TubeGeometry(track.curve, 2400, 0.08, 6, true), steelMat));

    // Side rails — バンク込みの bin（右方向）で左右にずらす
    const RAIL_STEP = 2; // サンプル 2 個ごと（約 1m）
    const leftRailPoints: THREE.Vector3[] = [];
    const rightRailPoints: THREE.Vector3[] = [];
    for (let i = 0; i < track.samples.length; i += RAIL_STEP) {
      const { pos, bin } = track.samples[i];
      leftRailPoints.push(pos.clone().addScaledVector(bin, -0.5));
      rightRailPoints.push(pos.clone().addScaledVector(bin, 0.5));
    }
    const railSegments = leftRailPoints.length * 2;
    scene.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(leftRailPoints, true), railSegments, 0.07, 5, true), steelMat));
    scene.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rightRailPoints, true), railSegments, 0.07, 5, true), steelMat));

    // Ties — バンクに合わせて傾ける（x = 右, y = 上, z = 後ろ）
    const tieMat = new THREE.MeshStandardMaterial({ color: 0x8b6914 });
    const tieGeo = new THREE.BoxGeometry(1.4, 0.1, 0.25);
    const tieBasis = new THREE.Matrix4();
    const back = new THREE.Vector3();
    for (let i = 0; i < track.samples.length; i += 3) {
      const { pos, tan, nor, bin } = track.samples[i];
      const tie = new THREE.Mesh(tieGeo, tieMat);
      tie.position.copy(pos);
      tie.quaternion.setFromRotationMatrix(tieBasis.makeBasis(bin, nor, back.copy(tan).negate()));
      scene.add(tie);
    }

    // Poles — 約 8m ごと。真下に別の線路が通る所（ヘリックスや交差部）には立てない
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const samples = track.samples;
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
    for (let i = 0; i < samples.length; i += 16) {
      const { pos } = samples[i];
      if (pos.y > 1.5 && !hasTrackBelow(i)) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, pos.y, 6), poleMat);
        pole.position.set(pos.x, pos.y / 2, pos.z);
        scene.add(pole);
      }
    }

    // ---- Passenger ----
    const passengerGroup = new THREE.Group();

    // Body
    const bodyMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.55, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x3366cc })
    );
    bodyMesh.position.y = 0;
    passengerGroup.add(bodyMesh);

    // Head
    const headMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.16),
      new THREE.MeshStandardMaterial({ color: 0xffcc99 })
    );
    headMesh.position.y = 0.52;
    passengerGroup.add(headMesh);

    // Hair
    const hairMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.17),
      new THREE.MeshStandardMaterial({ color: 0x222222 })
    );
    hairMesh.position.y = 0.6;
    hairMesh.scale.y = 0.6;
    passengerGroup.add(hairMesh);

    // Eyes
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
    const eyeGeo = new THREE.SphereGeometry(0.03);
    const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.position.set(-0.06, 0.53, 0.14);
    passengerGroup.add(leftEye);
    const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.position.set(0.06, 0.53, 0.14);
    passengerGroup.add(rightEye);

    // Arms
    const armGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.4);
    const armMat = new THREE.MeshStandardMaterial({ color: 0x3366cc });
    const leftArm = new THREE.Mesh(armGeo, armMat);
    leftArm.rotation.z = 0.4;
    leftArm.position.set(-0.28, -0.03, 0);
    passengerGroup.add(leftArm);
    const rightArm = new THREE.Mesh(armGeo, armMat);
    rightArm.rotation.z = -0.4;
    rightArm.position.set(0.28, -0.03, 0);
    passengerGroup.add(rightArm);

    // Legs
    const legGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.4);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x1a3366 });
    const leftLeg = new THREE.Mesh(legGeo, legMat);
    leftLeg.position.set(-0.1, -0.47, 0);
    passengerGroup.add(leftLeg);
    const rightLeg = new THREE.Mesh(legGeo, legMat);
    rightLeg.position.set(0.1, -0.47, 0);
    passengerGroup.add(rightLeg);

    // カートのローカル座標は x = 左, y = 上, z = 前。乗客は左の席に前向きで座る
    passengerGroup.position.set(0.6, 0.55, 0);

    // ---- Cart ----
    const cartGroup = new THREE.Group();

    const cartBody = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.4, 2.2),
      new THREE.MeshStandardMaterial({ color: 0xdd2222 })
    );
    cartBody.position.y = -0.2;
    cartGroup.add(cartBody);

    const safetyBar = new THREE.Mesh(
      new THREE.TorusGeometry(0.55, 0.04, 8, 20, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x888888 })
    );
    cartGroup.add(safetyBar);

    cartGroup.add(passengerGroup);
    scene.add(cartGroup);

    const cartBasis = new THREE.Matrix4();

    // ---- Clock ----
    const clock = new THREE.Clock();

    // ---- Animation ----
    function animate() {
      animFrameIdRef.current = requestAnimationFrame(animate);
      const delta = clock.getDelta();

      if (startedRef.current) {
        const keys = keysRef.current;
        const keyDelta = KEY_SPEED * delta;

        if (keys['ArrowLeft']) yawRef.current += keyDelta;
        if (keys['ArrowRight']) yawRef.current -= keyDelta;
        if (keys['ArrowUp']) pitchRef.current -= keyDelta;
        if (keys['ArrowDown']) pitchRef.current += keyDelta;

        yawRef.current = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, yawRef.current));
        pitchRef.current = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, pitchRef.current));

        yawRef.current *= 0.998;
        pitchRef.current *= 0.998;

        // ---- 走行（速度・位置・G を物理モジュールで更新） ----
        physics.step(ride, delta);
        const { pos, tan, nor, bin } = track.at(ride.s);

        // カメラ用：前 = tan, 上 = nor（バンクで一緒に傾く）
        const baseQuat = new THREE.Quaternion().setFromRotationMatrix(
          new THREE.Matrix4().lookAt(new THREE.Vector3(0, 0, 0), tan, nor)
        );

        // カメラ: レール上 + 乗客の目の高さ
        const eyePos = pos.clone()
          .addScaledVector(nor, 1.2)
          .addScaledVector(tan, 0.1);

        // 首振り: nor まわりが yaw（左右）、bin まわりが pitch（上下）
        const yawQ   = new THREE.Quaternion().setFromAxisAngle(nor, yawRef.current);
        const pitchQ = new THREE.Quaternion().setFromAxisAngle(bin, pitchRef.current);
        const finalQuat = yawQ.multiply(pitchQ).multiply(baseQuat);

        camera.position.copy(eyePos);
        camera.quaternion.copy(finalQuat);

        // HUD
        if (speedSpanRef.current) speedSpanRef.current.textContent = `${Math.round(ride.v * 3.6)}`;
        if (gSpanRef.current) gSpanRef.current.textContent = ride.g.z.toFixed(1);
      }

      // カート：x = 左(-bin), y = 上(nor), z = 前(tan)。発車前も駅に置いておく
      const cart = track.at(ride.s);
      cartGroup.position.copy(cart.pos).addScaledVector(cart.nor, 0.3);
      cartGroup.quaternion.setFromRotationMatrix(cartBasis.makeBasis(cart.bin.negate(), cart.nor, cart.tan));

      renderer.render(scene, camera);
    }

    animate();

    // ---- Event Listeners ----
    function onMouseDown(e: MouseEvent) {
      draggingRef.current = true;
      lastMXRef.current = e.clientX;
      lastMYRef.current = e.clientY;
    }

    function onMouseUp() {
      draggingRef.current = false;
    }

    function onMouseMove(e: MouseEvent) {
      if (!draggingRef.current || !startedRef.current) return;
      const dx = e.clientX - lastMXRef.current;
      const dy = e.clientY - lastMYRef.current;
      yawRef.current -= dx * 0.003;
      pitchRef.current += dy * 0.003;
      yawRef.current = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, yawRef.current));
      pitchRef.current = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, pitchRef.current));
      lastMXRef.current = e.clientX;
      lastMYRef.current = e.clientY;
    }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length > 0) {
        lastTXRef.current = e.touches[0].clientX;
        lastTYRef.current = e.touches[0].clientY;
      }
    }

    function onTouchMove(e: TouchEvent) {
      if (!startedRef.current || e.touches.length === 0) return;
      const dx = e.touches[0].clientX - lastTXRef.current;
      const dy = e.touches[0].clientY - lastTYRef.current;
      yawRef.current -= dx * 0.004;
      pitchRef.current += dy * 0.004;
      yawRef.current = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, yawRef.current));
      pitchRef.current = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, pitchRef.current));
      lastTXRef.current = e.touches[0].clientX;
      lastTYRef.current = e.touches[0].clientY;
    }

    function onKeyDown(e: KeyboardEvent) {
      keysRef.current[e.key] = true;
    }

    function onKeyUp(e: KeyboardEvent) {
      keysRef.current[e.key] = false;
    }

    function onResize() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    }

    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(animFrameIdRef.current);
      container.removeChild(renderer.domElement);
      renderer.dispose();
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  function handleStart() {
    const ss = startScreenRef.current;
    const hud = hudRef.current;
    if (ss) {
      ss.style.transition = 'opacity 0.5s ease';
      ss.style.opacity = '0';
      ss.style.pointerEvents = 'none';
    }
    if (hud) {
      hud.style.transition = 'opacity 0.5s ease 0.3s';
      hud.style.opacity = '1';
    }
    setTimeout(() => {
      startedRef.current = true;
      if (ss) ss.style.display = 'none';
    }, 600);
  }

  return (
    <div className="relative w-full h-screen overflow-hidden">
      {/* Three.js canvas container */}
      <div ref={containerRef} className="absolute inset-0" />

      {/* Start screen – always in DOM, fades out on start */}
      <div
        ref={startScreenRef}
        className="fixed inset-0 flex items-center justify-center z-10"
      >
        <div className="text-center px-8">
          <h1
            className="text-5xl text-white font-extrabold mb-4"
            style={{ textShadow: '0 0 20px #ff8800, 0 0 40px #ff4400, 2px 2px 4px rgba(0,0,0,0.8)' }}
          >
            Rollercoaster
          </h1>
          <p className="text-white text-lg mb-8 drop-shadow-lg">
            Hold mouse or use arrow keys to look around
          </p>
          <button
            onClick={handleStart}
            className="bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-400 hover:to-red-400 rounded-full px-12 py-4 text-xl font-bold text-white shadow-lg transition-all duration-200 hover:scale-105"
          >
            Ride Now!
          </button>
          <div className="mt-6">
            <Link
              href="/simulator"
              className="inline-block rounded-full bg-black/40 px-6 py-2 text-white backdrop-blur-sm hover:bg-black/55 focus-visible:outline-2 focus-visible:outline-white"
            >
              コースを作って試す（シミュレーター）
            </Link>
          </div>
        </div>
      </div>

      {/* HUD – always in DOM, starts invisible, fades in on start */}
      <div ref={hudRef} className="fixed inset-0 z-10 pointer-events-none" style={{ opacity: 0 }}>
        {/* Top left – back to home */}
        <div className="absolute top-4 left-4 pointer-events-auto">
          <Link
            href="/"
            className="inline-block rounded-full bg-black/40 px-4 py-2 text-white text-sm backdrop-blur-sm hover:bg-black/60 transition-colors"
          >
            ← Home
          </Link>
        </div>

        {/* Bottom center */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-4 text-white text-sm pointer-events-none">
          <span className="bg-black/40 rounded-full px-4 py-1 backdrop-blur-sm">
            Mouse drag / Arrow keys to look
          </span>
        </div>

        {/* Top right speed meter */}
        <div
          className="absolute top-4 right-4 bg-black/50 rounded-xl px-5 py-3 text-white backdrop-blur-sm"
          style={{ textShadow: '0 0 8px #ff8800' }}
        >
          <div className="text-xs text-orange-300 mb-1 tracking-widest uppercase">Speed</div>
          <div className="text-2xl font-bold">
            <span ref={speedSpanRef}>0</span>
            <span className="text-sm font-normal ml-1 text-orange-200">km/h</span>
          </div>
          <div className="text-xs text-orange-300 mt-2 mb-1 tracking-widest uppercase">G</div>
          <div className="text-2xl font-bold">
            <span ref={gSpanRef}>1.0</span>
          </div>
        </div>

        {/* Center crosshair */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative w-6 h-6">
            <div className="absolute top-1/2 left-0 w-full h-px bg-white/60 -translate-y-1/2" />
            <div className="absolute left-1/2 top-0 h-full w-px bg-white/60 -translate-x-1/2" />
          </div>
        </div>
      </div>
    </div>
  );
}
