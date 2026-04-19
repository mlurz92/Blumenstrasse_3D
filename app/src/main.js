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
const canvas = document.getElementById("scene");
const frameInfoEl = document.getElementById("frameInfo");

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0c1016);
scene.fog = new THREE.Fog(0x0c1016, 6, 28);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 300);
camera.position.set(1.1, 1.65, 1.3);

const hemi = new THREE.HemisphereLight(0xeaf4ff, 0x253040, 0.55);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(6, 9, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun);

const ambient = new THREE.AmbientLight(0xffffff, 0.18);
scene.add(ambient);

const pointer = {
  locked: false,
  yaw: 0,
  pitch: 0,
};

const keys = new Set();
document.addEventListener("keydown", (e) => keys.add(e.code));
document.addEventListener("keyup", (e) => keys.delete(e.code));

canvas.addEventListener("click", () => canvas.requestPointerLock());
document.addEventListener("pointerlockchange", () => {
  pointer.locked = document.pointerLockElement === canvas;
});

document.addEventListener("mousemove", (e) => {
  if (!pointer.locked) return;
  pointer.yaw -= e.movementX * 0.0018;
  pointer.pitch -= e.movementY * 0.0018;
  pointer.pitch = Math.max(-Math.PI / 2.1, Math.min(Math.PI / 2.1, pointer.pitch));
});

const textureLoader = new THREE.TextureLoader();

function polygonToShape(points) {
  const shape = new THREE.Shape();
  points.forEach((p, idx) => {
    if (idx === 0) shape.moveTo(p[0], p[1]);
    else shape.lineTo(p[0], p[1]);
  });
  shape.closePath();
  return shape;
}

function makeRoomMesh(room, ceilingHeight) {
  const shape = polygonToShape(room.polygon);
  const floorGeom = new THREE.ShapeGeometry(shape);
  floorGeom.rotateX(-Math.PI / 2);

  const floorMat = new THREE.MeshStandardMaterial({
    color: room.floorTexture === "tile_dark" ? 0x54585f : room.floorTexture === "tile_light" ? 0xb9bbbe : 0x8f745f,
    roughness: 0.86,
    metalness: 0.03,
  });
  const floor = new THREE.Mesh(floorGeom, floorMat);
  floor.receiveShadow = true;
  floor.position.y = 0;

  const edge = new THREE.EdgesGeometry(floorGeom);
  const edgeLines = new THREE.LineSegments(
    edge,
    new THREE.LineBasicMaterial({ color: 0x1f2b38, transparent: true, opacity: 0.7 })
  );

  const ceiling = new THREE.Mesh(
    floorGeom.clone(),
    new THREE.MeshStandardMaterial({ color: 0xf1f1ef, roughness: 0.95, metalness: 0 })
  );
  ceiling.position.y = ceilingHeight;
  ceiling.receiveShadow = true;

  return [floor, edgeLines, ceiling];
}

function addWallSegment(a, b, h, thickness, mat) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  const geom = new THREE.BoxGeometry(len, h, thickness);
  const wall = new THREE.Mesh(geom, mat);
  wall.castShadow = true;
  wall.receiveShadow = true;
  wall.position.set((a[0] + b[0]) / 2, h / 2, (a[1] + b[1]) / 2);
  wall.rotation.y = -Math.atan2(dz, dx);
  scene.add(wall);
}

function buildWalls(layout) {
  const m = new THREE.MeshStandardMaterial({ color: 0xe8eaec, roughness: 0.88, metalness: 0.01 });
  const h = layout.meta.ceiling_height;
  const t = layout.meta.wall_thickness;

  // Für Demo: Raumumrisse als Wände ohne boolesche Door/Window-Ausschnitte;
  // Öffnungen werden visuell markiert und die Bewegung bleibt frei.
  for (const room of layout.rooms) {
    const pts = room.polygon;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      addWallSegment(a, b, h, t, m);
    }
  }

  const doorMat = new THREE.MeshStandardMaterial({ color: 0x7a4f2d, roughness: 0.7 });
  const windowMat = new THREE.MeshStandardMaterial({ color: 0x95d9ff, transparent: true, opacity: 0.35 });

  layout.openings.doors.forEach((d) => {
    const [a, b] = d.wall;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const g = new THREE.BoxGeometry(len, d.height, 0.04);
    const mesh = new THREE.Mesh(g, doorMat);
    mesh.position.set((a[0] + b[0]) / 2, d.height / 2 + d.sill, (a[1] + b[1]) / 2);
    mesh.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
    scene.add(mesh);
  });

  layout.openings.windows.forEach((w) => {
    const [a, b] = w.wall;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const g = new THREE.PlaneGeometry(len, w.height);
    const mesh = new THREE.Mesh(g, windowMat);
    mesh.position.set((a[0] + b[0]) / 2, w.sill + w.height / 2, (a[1] + b[1]) / 2);
    mesh.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
    scene.add(mesh);
  });
}

function catmull(points, t) {
  const p = points;
  const n = p.length - 1;
  const scaled = t * n;
  const i = Math.min(n - 1, Math.max(0, Math.floor(scaled)));
  const localT = scaled - i;
  const p0 = p[Math.max(0, i - 1)];
  const p1 = p[i];
  const p2 = p[Math.min(n, i + 1)];
  const p3 = p[Math.min(n, i + 2)];

  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    out[k] =
      0.5 *
      ((2 * p1[k]) +
        (-p0[k] + p2[k]) * localT +
        (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * localT * localT +
        (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * localT * localT * localT);
  }
  return out;
}

function buildFrameProjectionCloud(layout, frameData) {
  const group = new THREE.Group();
  const path = layout.camera_path;

  const everyN = 30;
  const planes = [];
  for (let i = 0; i < frameData.frames.length; i += everyN) {
    const f = frameData.frames[i];
    const t = i / Math.max(1, frameData.frames.length - 1);
    const p = catmull(path, t);
    const n = catmull(path, Math.min(1, t + 0.01));

    const dir = new THREE.Vector3(n[0] - p[0], 0, n[2] - p[2]).normalize();
    const angle = Math.atan2(dir.x, dir.z);

    const tex = textureLoader.load(f.file);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;

    const aspect = f.width / f.height;
    const h = 1.8;
    const w = h * aspect;

    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.2, depthWrite: false })
    );
    mesh.position.set(p[0], p[2], p[1]);
    mesh.position.y = p[2];
    mesh.position.z = p[1];
    mesh.rotation.y = angle;
    group.add(mesh);
    planes.push({ mesh, frame: f, t });
  }

  scene.add(group);
  return planes;
}

function distance2D(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fehler beim Laden: ${url}`);
  return res.json();
}

function setupLayout(layout) {
  for (const room of layout.rooms) {
    const meshes = makeRoomMesh(room, layout.meta.ceiling_height);
    meshes.forEach((m) => scene.add(m));
  }
  buildWalls(layout);

  const grid = new THREE.GridHelper(20, 80, 0x1b2734, 0x14202b);
  grid.position.y = 0.01;
  scene.add(grid);
}

function buildControls() {
  const velocity = new THREE.Vector3();

  return (dt) => {
    const base = keys.has("ShiftLeft") ? 4.8 : 2.6;
    const speed = base * dt;
    const yawQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, pointer.yaw, 0, "YXZ"));

    velocity.set(0, 0, 0);
    if (keys.has("KeyW")) velocity.z -= 1;
    if (keys.has("KeyS")) velocity.z += 1;
    if (keys.has("KeyA")) velocity.x -= 1;
    if (keys.has("KeyD")) velocity.x += 1;

    velocity.normalize().multiplyScalar(speed);
    velocity.applyQuaternion(yawQuat);

    camera.position.add(velocity);
    if (keys.has("KeyQ")) camera.position.y += speed;
    if (keys.has("KeyE")) camera.position.y -= speed;

    camera.position.y = Math.max(0.25, Math.min(2.45, camera.position.y));

    camera.rotation.order = "YXZ";
    camera.rotation.y = pointer.yaw;
    camera.rotation.x = pointer.pitch;
  };
}

(async function main() {
  const [layout, frameData] = await Promise.all([
    loadJSON("./data/floorplan-layout.json"),
    loadJSON("./data/frame-analysis.json"),
  ]);

  setupLayout(layout);
  const framePlanes = buildFrameProjectionCloud(layout, frameData);
  const controlTick = buildControls();

  const dominantFramePlane = new THREE.Mesh(
    new THREE.PlaneGeometry(2.1, 1.2),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 })
  );
  dominantFramePlane.position.set(0, 1.65, -1.8);
  scene.add(dominantFramePlane);

  let dominantTex = null;
  function updateDominantFrame() {
    let nearest = null;
    let best = Infinity;
    for (const fp of framePlanes) {
      const d = distance2D(camera.position, fp.mesh.position);
      if (d < best) {
        best = d;
        nearest = fp;
      }
    }
    if (!nearest) return;

    frameInfoEl.textContent = `Frame: #${nearest.frame.frame_number} @ ${nearest.frame.timestamp_seconds.toFixed(2)}s`;

    if (dominantTex) dominantTex.dispose();
    dominantTex = textureLoader.load(nearest.frame.file);
    dominantTex.colorSpace = THREE.SRGBColorSpace;
    dominantFramePlane.material.map = dominantTex;
    dominantFramePlane.material.needsUpdate = true;
  }

  const clock = new THREE.Clock();
  let accumulator = 0;

  function tick() {
    const dt = Math.min(clock.getDelta(), 0.05);
    accumulator += dt;

    controlTick(dt);

    if (accumulator > 0.15) {
      updateDominantFrame();
      accumulator = 0;
    }

    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  tick();
})();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
