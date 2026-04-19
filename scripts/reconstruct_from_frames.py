#!/usr/bin/env python3
"""Sparse 3D-Rekonstruktion direkt aus den gelieferten Frames.

Ablauf:
1) Laden einer Teilmenge der Frame-Bilder aus ./frames
2) ORB-Keypoint-Extraktion
3) Paarweises Matching auf benachbarten Frames
4) Relative Pose (Essential Matrix) + Triangulation
5) Export als app/data/reconstruction.json (Kamera-Posen + Sparse-Pointcloud)

Hinweis: Das ist eine robuste, reproduzierbare Sparse-SfM-Näherung ohne externe SfM-Tools.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import List

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
FRAMES_DIR = ROOT / "frames"
OUT_FILE = ROOT / "app" / "data" / "reconstruction.json"


@dataclass
class CameraPose:
    frame_number: int
    file: str
    position: list[float]
    rotation_matrix: list[list[float]]


@dataclass
class Point3D:
    xyz: list[float]
    color: list[int]


def sorted_frames() -> list[Path]:
    files = sorted(FRAMES_DIR.glob("frame_*.webp"), key=lambda p: int(p.stem.split("_")[-1]))
    if not files:
        raise SystemExit("Keine Frames gefunden")
    return files


def load_gray_and_color(path: Path) -> tuple[np.ndarray, np.ndarray]:
    color = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if color is None:
        raise RuntimeError(f"Bild kann nicht gelesen werden: {path}")
    gray = cv2.cvtColor(color, cv2.COLOR_BGR2GRAY)
    return gray, color


def to_camera_matrix(w: int, h: int) -> np.ndarray:
    # Approximation: Smartphone-Weitwinkel, f ~ 0.9 * max(dim)
    f = 0.9 * max(w, h)
    cx = w / 2
    cy = h / 2
    return np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], dtype=np.float64)


def triangulate_points(
    K: np.ndarray,
    R1: np.ndarray,
    t1: np.ndarray,
    R2: np.ndarray,
    t2: np.ndarray,
    pts1: np.ndarray,
    pts2: np.ndarray,
) -> np.ndarray:
    P1 = K @ np.hstack([R1, t1])
    P2 = K @ np.hstack([R2, t2])
    pts4d = cv2.triangulatePoints(P1, P2, pts1.T, pts2.T)
    pts3d = (pts4d[:3] / pts4d[3]).T
    return pts3d


def run_reconstruction(sample_step: int = 12, max_frames: int = 180) -> dict:
    frame_files = sorted_frames()
    sampled = frame_files[::sample_step][:max_frames]

    gray0, color0 = load_gray_and_color(sampled[0])
    h, w = gray0.shape
    K = to_camera_matrix(w, h)

    orb = cv2.ORB_create(nfeatures=3500, scaleFactor=1.2, nlevels=8)
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)

    kps_desc = []
    colors = []
    for p in sampled:
        g, c = load_gray_and_color(p)
        kps, des = orb.detectAndCompute(g, None)
        if des is None or len(kps) < 80:
            kps, des = [], None
        kps_desc.append((kps, des))
        colors.append(c)

    R_global = np.eye(3, dtype=np.float64)
    t_global = np.zeros((3, 1), dtype=np.float64)

    poses: List[CameraPose] = [
        CameraPose(
            frame_number=int(sampled[0].stem.split("_")[-1]),
            file=f"../frames/{sampled[0].name}",
            position=[0.0, 0.0, 0.0],
            rotation_matrix=R_global.tolist(),
        )
    ]

    sparse_points: list[np.ndarray] = []
    sparse_colors: list[np.ndarray] = []

    for i in range(1, len(sampled)):
        k1, d1 = kps_desc[i - 1]
        k2, d2 = kps_desc[i]
        if d1 is None or d2 is None:
            continue

        knn = matcher.knnMatch(d1, d2, k=2)
        good = []
        for pair in knn:
            if len(pair) != 2:
                continue
            m, n = pair
            if m.distance < 0.75 * n.distance:
                good.append(m)

        if len(good) < 80:
            continue

        pts1 = np.float32([k1[m.queryIdx].pt for m in good])
        pts2 = np.float32([k2[m.trainIdx].pt for m in good])

        E, inlier_mask = cv2.findEssentialMat(pts1, pts2, K, method=cv2.RANSAC, prob=0.999, threshold=1.25)
        if E is None or inlier_mask is None:
            continue

        inlier_mask = inlier_mask.ravel().astype(bool)
        pts1_in = pts1[inlier_mask]
        pts2_in = pts2[inlier_mask]

        if len(pts1_in) < 60:
            continue

        _, R_rel, t_rel, pose_mask = cv2.recoverPose(E, pts1_in, pts2_in, K)
        valid = pose_mask.ravel().astype(bool)

        pts1_pose = pts1_in[valid]
        pts2_pose = pts2_in[valid]
        if len(pts1_pose) < 40:
            continue

        R_next = R_rel @ R_global
        t_next = R_rel @ t_global + t_rel

        pts3d = triangulate_points(K, R_global, t_global, R_next, t_next, pts1_pose, pts2_pose)

        # Cheirality + robust depth clamp
        z = pts3d[:, 2]
        valid_depth = np.isfinite(z) & (z > 0.1) & (z < 60.0)
        pts3d = pts3d[valid_depth]

        if len(pts3d) > 0:
            frame_color = colors[i - 1]
            pxy = np.round(pts1_pose[valid_depth]).astype(int)
            pxy[:, 0] = np.clip(pxy[:, 0], 0, w - 1)
            pxy[:, 1] = np.clip(pxy[:, 1], 0, h - 1)
            rgb = frame_color[pxy[:, 1], pxy[:, 0], ::-1]  # BGR -> RGB
            sparse_points.append(pts3d)
            sparse_colors.append(rgb)

        frame_num = int(sampled[i].stem.split("_")[-1])
        poses.append(
            CameraPose(
                frame_number=frame_num,
                file=f"../frames/{sampled[i].name}",
                position=t_next.flatten().astype(float).tolist(),
                rotation_matrix=R_next.astype(float).tolist(),
            )
        )

        R_global, t_global = R_next, t_next

    if sparse_points:
        pts = np.vstack(sparse_points)
        cols = np.vstack(sparse_colors)

        # Downsample zur Browser-Renderbarkeit
        if len(pts) > 120000:
            idx = np.random.default_rng(42).choice(len(pts), size=120000, replace=False)
            pts = pts[idx]
            cols = cols[idx]

        cloud = [Point3D(xyz=pts[i].astype(float).tolist(), color=cols[i].astype(int).tolist()) for i in range(len(pts))]
    else:
        cloud = []

    return {
        "method": "sparse_sfm_orb_essential_triangulation",
        "input_total_frames": len(frame_files),
        "sample_step": sample_step,
        "used_frames": len(sampled),
        "camera_count": len(poses),
        "point_count": len(cloud),
        "camera_poses": [asdict(p) for p in poses],
        "points": [asdict(p) for p in cloud],
        "notes": {
            "scale_ambiguous": True,
            "coordinate_system": "OpenCV camera coordinate convention",
        },
    }


def main() -> None:
    result = run_reconstruction()
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"Rekonstruktion geschrieben: {OUT_FILE} | Kameras: {result['camera_count']} | Punkte: {result['point_count']}"
    )


if __name__ == "__main__":
    main()
