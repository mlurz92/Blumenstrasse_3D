# Blumenstraße 68 – 3D Rundgang (Video- & Frame-basiert)

## Kritische Selbstüberprüfung (Revision)

Die erste Version war lauffähig, aber nicht präzise genug in mehreren Punkten:

1. **Wände ohne echte Öffnungen:** Türen/Fenster wurden nur markiert, nicht korrekt als Durchbruch modelliert.
2. **Frame-Projektion zu grob:** Nur jeder 30. Frame wurde als Projektionsfläche genutzt.
3. **Architektur zu monolithisch:** Rendering, Eingabe und Datenlogik waren zu eng gekoppelt.

Diese Revision adressiert die Punkte durch echte Wandsegmentierung mit Öffnungsausschnitten, dichtere Frame-Projektion und klar getrennte Klassenstruktur.

## Architektur

1. **Asset-Analyse-Pipeline (`scripts/analyze_assets.py`)**
   - verarbeitet **jeden einzelnen WebP-Frame**,
   - extrahiert Auflösungen direkt aus RIFF/VP8-Headern,
   - berechnet Zeitstempel für alle Frames,
   - erzeugt `app/data/frame-analysis.json`.

2. **3D-Viewer (`app/src/main.js`)**
   - `AssetRepository`: Laden der JSON-Daten,
   - `WalkController`: Maus/WASD/QE + Pointer-Lock,
   - `FloorplanSceneBuilder`: Raumflächen, Decken, Wände **mit Öffnungsausschnitten**,
   - `FrameProjector`: dichtere framebasierte Projektion entlang des Kamerapfads + dynamisches Referenzbild.

3. **Grundrissdaten (`app/data/floorplan-layout.json`)**
   - Räume als Polygone,
   - Türen/Fenster als Öffnungen,
   - Metrik (Einheit, Wandstärke, Deckenhöhe),
   - Kamerapfad.

## Start

```bash
python3 scripts/analyze_assets.py
python3 -m http.server 8080
```

Dann im Browser:

- http://localhost:8080/app/

## Qualitäts-Hinweis

Diese Anwendung ist eine belastbare, frei begehbare 3D-Implementierung auf Basis der gelieferten Assets.
Für eine physikalisch-exakte 1:1-Rekonstruktion jedes Sichtstrahls (inkl. perfekter Tiefengeometrie pro Pixel) wäre zusätzlich eine vollständige SfM/MVS-Photogrammetrie- oder Neural-Reconstruction-Pipeline notwendig.
