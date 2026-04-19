# Blumenstraße 68 – 3D Rundgang (Video- & Frame-basiert)

Diese Anwendung erzeugt einen frei begehbaren 3D-Rundgang für die Wohnung basierend auf:

- `Blumenstraße_68_Leipzig.mp4`
- allen Bildern unter `frames/` (jeder einzelne Frame wird indexiert)
- dem beigefügten Grundriss (`blu gr we 10.pdf`)

## Architektur (kurz)

1. **Asset-Analyse-Pipeline (Python)**
   - Liest Video-Metadaten via `ffprobe`.
   - Liest **jeden einzelnen WebP-Frame** und extrahiert Breite/Höhe über RIFF/VP8-Header.
   - Erzeugt eine vollständige JSON-Datei mit Zeitstempel, Dateiname, Auflösung, Luminanz-Heuristik.

2. **3D-Engine (Three.js / WebGL2)**
   - Freie Bewegung (WASD, Maus, Q/E, Shift).
   - Grundriss-nahe Geometrie (Wände, Türen, Fenster) als metrisches Datenmodell.
   - GPU-freundliche Frame-Projektion: jeder n-te Frame wird als Szene-Plane entlang eines Kamerapfads verteilt.
   - Dynamische Aktualisierung eines „aktuellen“ Frame-Overlays abhängig von Position auf dem Pfad.

3. **Datenmodell**
   - `app/data/floorplan-layout.json`: Räume, Wandsegmente, Öffnungen.
   - `app/data/frame-analysis.json`: vollständige Frame-Tabelle (automatisch generiert).

## Start

```bash
python3 scripts/analyze_assets.py
python3 -m http.server 8080
```

Dann im Browser öffnen:

- http://localhost:8080/app/

## Hinweise

- Das Projekt ist bewusst modular, damit Maßkorrekturen aus dem Grundriss schnell in `floorplan-layout.json` nachgeführt werden können.
- Für produktive Photogrammetrie-Rekonstruktion können später COLMAP/OpenMVG/Meshroom-Stufen ergänzt werden, ohne die Viewer-Architektur neu zu schreiben.
