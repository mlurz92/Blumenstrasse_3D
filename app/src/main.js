import * as THREE from "https://unpkg.com/three@0.164.1/build/three.module.js";

class AssetRepository {
  static async loadJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fehler beim Laden: ${url}`);
    return res.json();
  }

  static async loadAll() {
    const [layout, frameAnalysis, reconstruction] = await Promise.all([
      this.loadJSON("./data/floorplan-layout.json"),
      this.loadJSON("./data/frame-analysis.json"),
      this.loadJSON("./data/reconstruction.json"),
    ]);
    return { layout, frameAnalysis, reconstruction };
  }
}

class ReconstructionAligner {
  constructor(layout, reconstruction) {
    this.layout = layout;
    this.reconstruction = reconstruction;
    this.poseWorld = [];
  }

  static bounds2D(points) {
    const xs = points.map((p) => p[0]);
    const zs = points.map((p) => p[1]);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minZ: Math.min(...zs),
      maxZ: Math.max(...zs),
    };
  }

  map() {
    const floorPts = this.layout.rooms.flatMap((r) => r.polygon);
    const floorBounds = ReconstructionAligner.bounds2D(floorPts);

    const poses = this.reconstruction.camera_poses || [];
    if (poses.length < 2) {
      this.poseWorld = [];
      return;
    }

    const raw2d = poses.map((p) => [p.position[0], p.position[2]]);
    const rawBounds = ReconstructionAligner.bounds2D(raw2d);

    const rawW = Math.max(1e-6, rawBounds.maxX - rawBounds.minX);
    const rawH = Math.max(1e-6, rawBounds.maxZ - rawBounds.minZ);
    const floorW = Math.max(1e-6, floorBounds.maxX - floorBounds.minX);
    const floorH = Math.max(1e-6, floorBounds.maxZ - floorBounds.minZ);

    const scale = 0.9 * Math.min(floorW / rawW, floorH / rawH);

    const floorCx = (floorBounds.minX + floorBounds.maxX) * 0.5;
    const floorCz = (floorBounds.minZ + floorBounds.maxZ) * 0.5;
    const rawCx = (rawBounds.minX + rawBounds.maxX) * 0.5;
    const rawCz = (rawBounds.minZ + rawBounds.maxZ) * 0.5;

    this.poseWorld = poses.map((p) => {
      const x = (p.position[0] - rawCx) * scale + floorCx;
      const z = (p.position[2] - rawCz) * scale + floorCz;
      const y = 1.62;
      return {
        ...p,
        world: [x, y, z],
        scale,
      };
    });
  }

  mapPointCloud(points) {
    if (!this.poseWorld.length || !points?.length) return [];

    const rawPoses = (this.reconstruction.camera_poses || []).map((p) => [p.position[0], p.position[2]]);
    const rawBounds = ReconstructionAligner.bounds2D(rawPoses);

    const floorPts = this.layout.rooms.flatMap((r) => r.polygon);
    const floorBounds = ReconstructionAligner.bounds2D(floorPts);

    const rawCx = (rawBounds.minX + rawBounds.maxX) * 0.5;
    const rawCz = (rawBounds.minZ + rawBounds.maxZ) * 0.5;
    const floorCx = (floorBounds.minX + floorBounds.maxX) * 0.5;
    const floorCz = (floorBounds.minZ + floorBounds.maxZ) * 0.5;

    const scale = this.poseWorld[0].scale;

    return points.map((p) => ({
      x: (p.xyz[0] - rawCx) * scale + floorCx,
      y: Math.max(0.05, Math.min(2.65, 1.25 + p.xyz[1] * scale * 0.5)),
      z: (p.xyz[2] - rawCz) * scale + floorCz,
      color: p.color,
    }));
  }
}

class WalkController {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.camera = camera;
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.pointerLocked = false;
    this.bind();
  }

  bind() {
    document.addEventListener("keydown", (e) => this.keys.add(e.code));
    document.addEventListener("keyup", (e) => this.keys.delete(e.code));
    this.canvas.addEventListener("click", () => this.canvas.requestPointerLock());

    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.pointerLocked) return;
      this.yaw -= e.movementX * 0.0018;
      this.pitch -= e.movementY * 0.0018;
      this.pitch = Math.max(-Math.PI / 2.1, Math.min(Math.PI / 2.1, this.pitch));
    });
  }

  tick(dt) {
    const speed = (this.keys.has("ShiftLeft") ? 4.8 : 2.6) * dt;
    const move = new THREE.Vector3();
    if (this.keys.has("KeyW")) move.z -= 1;
    if (this.keys.has("KeyS")) move.z += 1;
    if (this.keys.has("KeyA")) move.x -= 1;
    if (this.keys.has("KeyD")) move.x += 1;
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed);
      move.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, this.yaw, 0, "YXZ")));
      this.camera.position.add(move);
    }
    if (this.keys.has("KeyQ")) this.camera.position.y += speed;
    if (this.keys.has("KeyE")) this.camera.position.y -= speed;

    this.camera.position.y = Math.max(0.3, Math.min(2.5, this.camera.position.y));
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
  }
}

class FloorplanSceneBuilder {
  constructor(scene, layout) {
    this.scene = scene;
    this.layout = layout;
    this.wallMat = new THREE.MeshStandardMaterial({ color: 0xe7eaee, roughness: 0.88, metalness: 0.02 });
    this.floorMats = {
      oak: new THREE.MeshStandardMaterial({ color: 0x8e755d, roughness: 0.86, metalness: 0.02 }),
      tile_light: new THREE.MeshStandardMaterial({ color: 0xbcbec2, roughness: 0.9, metalness: 0.01 }),
      tile_dark: new THREE.MeshStandardMaterial({ color: 0x555a62, roughness: 0.93, metalness: 0.01 }),
    };
  }

  static polygonToShape(points) {
    const shape = new THREE.Shape();
    points.forEach((p, i) => (i === 0 ? shape.moveTo(p[0], p[1]) : shape.lineTo(p[0], p[1])));
    shape.closePath();
    return shape;
  }

  static segLen(a, b) {
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  static onSeg(p, a, b, eps = 1e-4) {
    const cross = (p[1] - a[1]) * (b[0] - a[0]) - (p[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(cross) > eps) return false;
    const dot = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]);
    if (dot < -eps) return false;
    const lenSq = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    return dot - lenSq <= eps;
  }

  addWallPiece(a, b, y0, y1, thickness) {
    const len = FloorplanSceneBuilder.segLen(a, b);
    if (len < 1e-3 || y1 <= y0) return;

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, y1 - y0, thickness), this.wallMat);
    mesh.position.set((a[0] + b[0]) * 0.5, (y0 + y1) * 0.5, (a[1] + b[1]) * 0.5);
    mesh.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  buildRooms() {
    const ceilingH = this.layout.meta.ceiling_height;
    for (const room of this.layout.rooms) {
      const geom = new THREE.ShapeGeometry(FloorplanSceneBuilder.polygonToShape(room.polygon));
      geom.rotateX(-Math.PI / 2);

      const floor = new THREE.Mesh(geom, this.floorMats[room.floorTexture] ?? this.floorMats.oak);
      floor.receiveShadow = true;
      const ceil = new THREE.Mesh(
        geom.clone(),
        new THREE.MeshStandardMaterial({ color: 0xf1f1ef, roughness: 0.96, metalness: 0.0 })
      );
      ceil.position.y = ceilingH;
      ceil.receiveShadow = true;

      this.scene.add(floor, ceil);
    }
  }

  buildWalls() {
    const edges = new Map();
    for (const room of this.layout.rooms) {
      const pts = room.polygon;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const key = [a, b]
          .map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`)
          .sort()
          .join("|");
        edges.set(key, { a, b });
      }
    }

    const openings = [
      ...this.layout.openings.doors.map((d) => ({ ...d, type: "door" })),
      ...this.layout.openings.windows.map((w) => ({ ...w, type: "window" })),
    ];

    for (const { a, b } of edges.values()) {
      const segOpenings = openings.filter(
        (o) => FloorplanSceneBuilder.onSeg(o.wall[0], a, b) && FloorplanSceneBuilder.onSeg(o.wall[1], a, b)
      );
      this.buildWallSegmentWithOpenings(a, b, segOpenings);
    }

    const glassMat = new THREE.MeshStandardMaterial({ color: 0x8ad8ff, transparent: true, opacity: 0.33 });
    for (const win of this.layout.openings.windows) {
      const a = win.wall[0];
      const b = win.wall[1];
      const len = FloorplanSceneBuilder.segLen(a, b);
      const w = new THREE.Mesh(new THREE.PlaneGeometry(len, win.height), glassMat);
      w.position.set((a[0] + b[0]) * 0.5, win.sill + win.height * 0.5, (a[1] + b[1]) * 0.5);
      w.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
      this.scene.add(w);
    }
  }

  buildWallSegmentWithOpenings(a, b, openings) {
    const H = this.layout.meta.ceiling_height;
    const T = this.layout.meta.wall_thickness;
    const L = FloorplanSceneBuilder.segLen(a, b);

    const intervals = openings
      .map((o) => {
        const t0 = FloorplanSceneBuilder.segLen(a, o.wall[0]) / L;
        const t1 = FloorplanSceneBuilder.segLen(a, o.wall[1]) / L;
        return {
          s: Math.max(0, Math.min(t0, t1)),
          e: Math.min(1, Math.max(t0, t1)),
          y0: o.sill,
          y1: o.sill + o.height,
        };
      })
      .sort((x, y) => x.s - y.s);

    const split = [0, ...intervals.flatMap((v) => [v.s, v.e]), 1]
      .sort((x, y) => x - y)
      .filter((v, i, arr) => i === 0 || Math.abs(v - arr[i - 1]) > 1e-4);

    const p = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

    for (let i = 0; i < split.length - 1; i++) {
      const s = split[i];
      const e = split[i + 1];
      const m = (s + e) * 0.5;
      const active = intervals.filter((v) => m >= v.s - 1e-5 && m <= v.e + 1e-5);
      const a2 = p(s);
      const b2 = p(e);

      if (!active.length) {
        this.addWallPiece(a2, b2, 0, H, T);
      } else {
        const low = Math.min(...active.map((x) => x.y0));
        const high = Math.max(...active.map((x) => x.y1));
        if (low > 0.01) this.addWallPiece(a2, b2, 0, low, T);
        if (high < H - 0.01) this.addWallPiece(a2, b2, high, H, T);
      }
    }
  }

  build() {
    this.buildRooms();
    this.buildWalls();
    const grid = new THREE.GridHelper(24, 96, 0x243344, 0x16212e);
    grid.position.y = 0.01;
    this.scene.add(grid);
  }
}

class ReconstructionCloud {
  constructor(scene, points) {
    this.scene = scene;
    this.points = points;
  }

  build() {
    if (!this.points?.length) return;

    const geom = new THREE.BufferGeometry();
    const pos = new Float32Array(this.points.length * 3);
    const col = new Float32Array(this.points.length * 3);

    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      pos[i * 3 + 0] = p.x;
      pos[i * 3 + 1] = p.y;
      pos[i * 3 + 2] = p.z;
      col[i * 3 + 0] = p.color[0] / 255;
      col[i * 3 + 1] = p.color[1] / 255;
      col[i * 3 + 2] = p.color[2] / 255;
    }

    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(col, 3));

    const mat = new THREE.PointsMaterial({ size: 0.03, vertexColors: true, transparent: true, opacity: 0.65 });
    const pts = new THREE.Points(geom, mat);
    this.scene.add(pts);
  }
}

class FrameProjector {
  constructor(scene, camera, alignedPoses, frameInfoNode) {
    this.scene = scene;
    this.camera = camera;
    this.alignedPoses = alignedPoses;
    this.frameInfoNode = frameInfoNode;
    this.texLoader = new THREE.TextureLoader();
    this.planes = [];
    this.dynamicTexture = null;
    this.dynamicPlane = null;
    this.lastFrameNumber = -1;
  }

  build() {
    if (!this.alignedPoses?.length) return;
    const group = new THREE.Group();

    for (let i = 0; i < this.alignedPoses.length; i++) {
      const pose = this.alignedPoses[i];
      const next = this.alignedPoses[Math.min(this.alignedPoses.length - 1, i + 1)];
      const dir = new THREE.Vector3(next.world[0] - pose.world[0], 0, next.world[2] - pose.world[2]).normalize();
      const angle = Math.atan2(dir.x, dir.z);

      const tex = this.texLoader.load(pose.file);
      tex.colorSpace = THREE.SRGBColorSpace;

      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1.05, 1.86),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.16, depthWrite: false })
      );
      mesh.position.set(pose.world[0], 1.62, pose.world[2]);
      mesh.rotation.y = angle;

      group.add(mesh);
      this.planes.push({ mesh, pose });
    }

    this.scene.add(group);

    this.dynamicPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(2.25, 1.26),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.94 })
    );
    this.dynamicPlane.position.set(0, 1.65, -2.05);
    this.scene.add(this.dynamicPlane);
  }

  nearest() {
    let best = null;
    let bestDist = Infinity;
    for (const it of this.planes) {
      const d = Math.hypot(this.camera.position.x - it.mesh.position.x, this.camera.position.z - it.mesh.position.z);
      if (d < bestDist) {
        best = it;
        bestDist = d;
      }
    }
    return best;
  }

  tick() {
    const n = this.nearest();
    if (!n) return;
    if (n.pose.frame_number === this.lastFrameNumber) return;

    this.lastFrameNumber = n.pose.frame_number;
    if (this.dynamicTexture) this.dynamicTexture.dispose();
    this.dynamicTexture = this.texLoader.load(n.pose.file);
    this.dynamicTexture.colorSpace = THREE.SRGBColorSpace;
    this.dynamicPlane.material.map = this.dynamicTexture;
    this.dynamicPlane.material.needsUpdate = true;
    this.frameInfoNode.textContent = `Frame: #${n.pose.frame_number}`;
  }
}

async function bootstrap() {
  const canvas = document.getElementById("scene");
  const frameInfo = document.getElementById("frameInfo");

  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("Canvas mit id 'scene' nicht gefunden.");
  }

  if (!(frameInfo instanceof HTMLElement)) {
    throw new Error("Element mit id 'frameInfo' nicht gefunden.");
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c1016);
  scene.fog = new THREE.Fog(0x0c1016, 6, 28);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 250);
  camera.position.set(1.1, 1.65, 1.3);

  scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x253040, 0.56));
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(6, 8, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0xffffff, 0.17));

  const { layout, reconstruction } = await AssetRepository.loadAll();

  if (!Array.isArray(layout?.rooms) || !Array.isArray(reconstruction?.camera_poses)) {
    throw new Error("Eingabedaten sind unvollständig oder beschädigt.");
  }

  new FloorplanSceneBuilder(scene, layout).build();

  const aligner = new ReconstructionAligner(layout, reconstruction);
  aligner.map();

  const worldCloud = aligner.mapPointCloud(reconstruction.points || []);
  new ReconstructionCloud(scene, worldCloud).build();

  const projector = new FrameProjector(scene, camera, aligner.poseWorld, frameInfo);
  projector.build();

  const walk = new WalkController(canvas, camera);
  const clock = new THREE.Clock();
  let acc = 0;

  function loop() {
    const dt = Math.min(clock.getDelta(), 0.05);
    acc += dt;
    walk.tick(dt);
    if (acc > 0.1) {
      projector.tick();
      acc = 0;
    }
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }

  loop();

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

bootstrap().catch((err) => {
  console.error(err);
  const hud = document.getElementById("hud");
  if (hud) {
    const p = document.createElement("p");
    p.textContent = `Fehler beim Start: ${err.message}`;
    hud.appendChild(p);
  }
});
