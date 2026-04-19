import * as THREE from "https://unpkg.com/three@0.164.1/build/three.module.js";

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
