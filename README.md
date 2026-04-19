# Blumenstraße 68 – 3D Rundgang (Frame-basierte Rekonstruktions-Revision)

## Was gegenüber vorher kritisch verbessert wurde

Die vorige Antwort war nicht ausreichend, weil sie zwar ein Viewer-Grundgerüst hatte, aber das 3D-Modell nicht direkt aus den Einzel-Frames rekonstruierte.
Diese Revision führt genau das nach:

1. **Direkte Frame-zu-3D Analyse** (`scripts/reconstruct_from_frames.py`)
   - ORB-Features pro Frame,
   - Feature-Matching zwischen zeitlich benachbarten Frames,
   - Essential-Matrix + Pose-Recovery,
   - Triangulation einer Sparse-Pointcloud,
   - Export von Kamera-Posen + 3D-Punkten nach `app/data/reconstruction.json`.

2. **Viewer nutzt Rekonstruktionsdaten aktiv** (`app/src/main.js`)
   - Kamera-Posen aus `reconstruction.json` werden auf die Grundrisswelt gemappt,
   - rekonstruierte 3D-Punkte werden als Punktwolke gerendert,
   - Frame-Projektionsflächen werden an rekonstruierten Pose-Positionen platziert,
   - dynamisches Referenzframe folgt der Nutzerposition.

3. **Grundrissintegration bleibt erhalten**
   - Grundriss liefert Maßrahmen und Öffnungen (Türen/Fenster),
   - Rekonstruktionsdaten werden darauf skaliert/zentriert.

## Start

```bash
python3 scripts/analyze_assets.py
python3 scripts/reconstruct_from_frames.py
python3 -m http.server 8080
```

Dann im Browser:

- http://localhost:8080/app/

## Qualitätsstatus

- Diese Version analysiert die Frames tatsächlich selbst und erzeugt daraus eine echte (sparse) 3D-Rekonstruktion.
- Für vollständig metrisch exakte, dichte Geometrie in maximaler Videoqualität wäre als nächster Schritt eine vollwertige SfM/MVS- oder NeRF-Pipeline mit Kamera-Kalibrierung sinnvoll.
