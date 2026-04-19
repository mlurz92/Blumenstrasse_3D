import * as THREE from "https://unpkg.com/three@0.164.1/build/three.module.js";

class AssetRepository {
  static async loadJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fehler beim Laden: ${url}`);
    return res.json();
  }

  static async loadAll() {
    const [layout, frameAnalysis] = await Promise.all([
      this.loadJSON("./data/floorplan-layout.json"),
      this.loadJSON("./data/frame-analysis.json"),
    ]);
    return { layout, frameAnalysis };
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

  buildRooms() {
    const ceilingH = this.layout.meta.ceiling_height;
    for (const room of this.layout.rooms) {
      const shape = FloorplanSceneBuilder.polygonToShape(room.polygon);
      const geom = new THREE.ShapeGeometry(shape);
      geom.rotateX(-Math.PI / 2);

      const floor = new THREE.Mesh(geom, this.floorMats[room.floorTexture] ?? this.floorMats.oak);
      floor.receiveShadow = true;

      const ceiling = new THREE.Mesh(
        geom.clone(),
        new THREE.MeshStandardMaterial({ color: 0xf1f1ef, roughness: 0.96, metalness: 0.0 })
      );
      ceiling.position.y = ceilingH;
      ceiling.receiveShadow = true;

      this.scene.add(floor, ceiling);

      const border = new THREE.LineSegments(
        new THREE.EdgesGeometry(geom),
        new THREE.LineBasicMaterial({ color: 0x1e2a36, transparent: true, opacity: 0.65 })
      );
      this.scene.add(border);
    }
  }

  static segmentLength(a, b) {
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  static isPointOnSegment(p, a, b, eps = 1e-4) {
    const cross = (p[1] - a[1]) * (b[0] - a[0]) - (p[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(cross) > eps) return false;
    const dot = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]);
    if (dot < -eps) return false;
    const lenSq = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    if (dot - lenSq > eps) return false;
    return true;
  }

  createBoxSegment(a, b, yBottom, yTop, thickness, material) {
    const len = FloorplanSceneBuilder.segmentLength(a, b);
    if (len <= 1e-3 || yTop <= yBottom) return;

    const geom = new THREE.BoxGeometry(len, yTop - yBottom, thickness);
    const mesh = new THREE.Mesh(geom, material);
    mesh.position.set((a[0] + b[0]) / 2, (yBottom + yTop) / 2, (a[1] + b[1]) / 2);
    mesh.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  buildWallWithOpenings(a, b, openings) {
    const wallThickness = this.layout.meta.wall_thickness;
    const ceilingH = this.layout.meta.ceiling_height;

    const len = FloorplanSceneBuilder.segmentLength(a, b);
    if (len <= 1e-4) return;

    const sortedIntervals = openings
      .map((o) => {
        const t0 = FloorplanSceneBuilder.segmentLength(a, o.wall[0]) / len;
        const t1 = FloorplanSceneBuilder.segmentLength(a, o.wall[1]) / len;
        return {
          tStart: Math.max(0, Math.min(t0, t1)),
          tEnd: Math.min(1, Math.max(t0, t1)),
          sill: o.sill,
          top: o.sill + o.height,
          type: o.type,
        };
      })
      .sort((x, y) => x.tStart - y.tStart);

    const split = [0, ...sortedIntervals.flatMap((o) => [o.tStart, o.tEnd]), 1]
      .sort((x, y) => x - y)
      .filter((v, i, arr) => i === 0 || Math.abs(v - arr[i - 1]) > 1e-4);

    const pointAt = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

    for (let i = 0; i < split.length - 1; i++) {
      const s = split[i];
      const e = split[i + 1];
      const mid = (s + e) * 0.5;
      const active = sortedIntervals.filter((o) => mid >= o.tStart - 1e-5 && mid <= o.tEnd + 1e-5);

      const p0 = pointAt(s);
      const p1 = pointAt(e);

      if (active.length === 0) {
        this.createBoxSegment(p0, p1, 0, ceilingH, wallThickness, this.wallMat);
      } else {
        const lowestSill = Math.min(...active.map((x) => x.sill));
        const highestTop = Math.max(...active.map((x) => x.top));

        if (lowestSill > 0.01) this.createBoxSegment(p0, p1, 0, lowestSill, wallThickness, this.wallMat);
        if (highestTop < ceilingH - 0.01)
          this.createBoxSegment(p0, p1, highestTop, ceilingH, wallThickness, this.wallMat);
      }
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

    const allOpenings = [
      ...this.layout.openings.doors.map((d) => ({ ...d, type: "door" })),
      ...this.layout.openings.windows.map((w) => ({ ...w, type: "window" })),
    ];

    for (const { a, b } of edges.values()) {
      const onSegmentOpenings = allOpenings.filter(
        (o) =>
          FloorplanSceneBuilder.isPointOnSegment(o.wall[0], a, b) &&
          FloorplanSceneBuilder.isPointOnSegment(o.wall[1], a, b)
      );
      this.buildWallWithOpenings(a, b, onSegmentOpenings);
    }

    const glass = new THREE.MeshStandardMaterial({ color: 0x96d8ff, transparent: true, opacity: 0.32 });
    for (const win of this.layout.openings.windows) {
      this.createWindowPlane(win, glass);
    }
  }

  createWindowPlane(win, material) {
    const a = win.wall[0];
    const b = win.wall[1];
    const len = FloorplanSceneBuilder.segmentLength(a, b);
    const geom = new THREE.PlaneGeometry(len, win.height);
    const mesh = new THREE.Mesh(geom, material);
    mesh.position.set((a[0] + b[0]) / 2, win.sill + win.height / 2, (a[1] + b[1]) / 2);
    mesh.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
    this.scene.add(mesh);
  }

  buildDebugGrid() {
    const grid = new THREE.GridHelper(24, 96, 0x243344, 0x16212e);
    grid.position.y = 0.01;
    this.scene.add(grid);
  }

  buildAll() {
    this.buildRooms();
    this.buildWalls();
    this.buildDebugGrid();
  }
}

class FrameProjector {
  constructor(scene, camera, layout, frameData, frameInfoNode) {
    this.scene = scene;
    this.camera = camera;
    this.layout = layout;
    this.frameData = frameData;
    this.frameInfoNode = frameInfoNode;

    this.textureLoader = new THREE.TextureLoader();
    this.framePlanes = [];
    this.dynamicPlane = null;
    this.dynamicTexture = null;
    this.lastFrameNumber = -1;
  }

  catmull(points, t) {
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
          (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * localT ** 2 +
          (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * localT ** 3);
    }
    return out;
  }

  buildFrameCloud() {
    const group = new THREE.Group();
    const path = this.layout.camera_path;

    const step = 15;
    for (let i = 0; i < this.frameData.frames.length; i += step) {
      const f = this.frameData.frames[i];
      const t = i / Math.max(1, this.frameData.frames.length - 1);
      const p = this.catmull(path, t);
      const n = this.catmull(path, Math.min(1, t + 0.008));

      const dir = new THREE.Vector3(n[0] - p[0], 0, n[1] - p[1]).normalize();
      const angle = Math.atan2(dir.x, dir.z);

      const tex = this.textureLoader.load(f.file);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;

      const h = 1.7;
      const w = h * (f.width / f.height);
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.16, depthWrite: false })
      );

      mesh.position.set(p[0], p[2], p[1]);
      mesh.rotation.y = angle;
      group.add(mesh);
      this.framePlanes.push({ mesh, frame: f, t });
    }

    this.scene.add(group);
  }

  buildDynamicPlane() {
    this.dynamicPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(2.25, 1.26),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.94 })
    );
    this.dynamicPlane.position.set(0, 1.65, -2.05);
    this.scene.add(this.dynamicPlane);
  }

  nearestFrameByPosition() {
    let best = null;
    let bestDist = Infinity;
    for (const fp of this.framePlanes) {
      const dx = this.camera.position.x - fp.mesh.position.x;
      const dz = this.camera.position.z - fp.mesh.position.z;
      const d = Math.hypot(dx, dz);
      if (d < bestDist) {
        bestDist = d;
        best = fp;
      }
    }
    return best;
  }

  updateDynamicFrame() {
    const nearest = this.nearestFrameByPosition();
    if (!nearest) return;

    if (nearest.frame.frame_number === this.lastFrameNumber) return;

    this.lastFrameNumber = nearest.frame.frame_number;
    this.frameInfoNode.textContent = `Frame: #${nearest.frame.frame_number} @ ${nearest.frame.timestamp_seconds.toFixed(3)}s`;

    if (this.dynamicTexture) this.dynamicTexture.dispose();
    this.dynamicTexture = this.textureLoader.load(nearest.frame.file);
    this.dynamicTexture.colorSpace = THREE.SRGBColorSpace;
    this.dynamicPlane.material.map = this.dynamicTexture;
    this.dynamicPlane.material.needsUpdate = true;
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
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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

  const { layout, frameAnalysis } = await AssetRepository.loadAll();

  new FloorplanSceneBuilder(scene, layout).buildAll();
  const frameProjector = new FrameProjector(scene, camera, layout, frameAnalysis, frameInfo);
  frameProjector.buildFrameCloud();
  frameProjector.buildDynamicPlane();

  const walk = new WalkController(canvas, camera);
  const clock = new THREE.Clock();
  let acc = 0;

  const loop = () => {
    const dt = Math.min(0.05, clock.getDelta());
    acc += dt;

    walk.tick(dt);
    if (acc > 0.1) {
      frameProjector.updateDynamicFrame();
      acc = 0;
    }

    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };

  loop();

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  const hud = document.getElementById("hud");
  if (hud) {
    const msg = document.createElement("p");
    msg.textContent = `Fehler beim Start: ${err.message}`;
    hud.appendChild(msg);
  }
});
