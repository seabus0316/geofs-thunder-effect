# GeoFS Lightning

A Tampermonkey userscript that adds visible 3D lightning and storm flashes to [GeoFS](https://www.geo-fs.com/).

- Lightning placed in real 3D world coordinates (main channel, branches, tapering width). It renders correctly as the camera moves and is occluded by terrain.
- Directional flash centered on the bolt: strong nearby, weak far away, with the cloud base lit up.
- Manual trigger, or automatic strikes driven by GeoFS thunderstorm weather.
- Integrated into the official GeoFS bottom toolbar.
- Can be fully disabled, removing every object, callback and timer it created.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new script, paste the contents of `geofs-lightning.user.js`, and save.
3. Open GeoFS and enter the flight view.

## Usage

A ⚡ button is added to the GeoFS bottom toolbar. Clicking it opens a small control popover. If the toolbar is not found, a small fallback panel appears at the bottom left.

Controls:

- **Lightning effect**: enable or disable the effect
- **Auto**: strike automatically based on thunderstorm weather
- **Flash brightness**: brightness of the screen flash
- **Test strike**: trigger one strike manually (requires the effect to be enabled)

The enabled state, Auto, and brightness are saved in the browser's localStorage (`geofsLightningSettings_v1`) and restored on reload.

**Console API**

```js
GeoFSLightning.enable()      // enable
GeoFSLightning.disable()     // disable and clean up resources
GeoFSLightning.strike()      // manual strike (must be enabled)
GeoFSLightning.setAuto(true) // toggle auto mode
GeoFSLightning.probe()       // print an API availability table (debugging)
GeoFSLightning.destroy()     // remove everything the script created
GeoFSLightning.cfg           // config object, editable at runtime
```

## Auto mode

Reads `weather.definition.thunderstorm` (observed range 0–100, normalized to 0–1). Below 0.05 nothing fires. Stronger storms strike more often: the mean interval goes from about 25 s (weak) to about 3 s (strong), randomized.

## Configuration

Edit `GeoFSLightning.cfg.<name>` in the Console (resets on reload). To change defaults permanently, edit `CFG` in the script.

| Option | Default | Description |
| --- | --- | --- |
| `minDist` / `maxDist` | 600 / 1800 | Horizontal distance from the camera (m) |
| `visFactor` | 0.18 | Max distance is capped at visibility × this value |
| `bearingSpread` | 35 | Random angle relative to camera heading (deg) |
| `cloudHeight` | 3000 | Bolt height when `cloudBase` is unavailable (m) |
| `minHeight` / `maxHeight` | 500 / 6000 | Bolt height limits (m) |
| `jitter` | 0.35 | Lateral jitter of the bolt path |
| `durationMs` | 380 | Duration of one strike |
| `flashPeak` | 0.6 | Max overlay opacity at the glow center |
| `flashAmbient` | 0.08 | Base glow far from the bolt (0 = none) |
| `flashFar` | 0.4 | Brightness multiplier for the farthest strikes |
| `coreWidths` / `glowWidths` | [1.5,2,2.5] / [5,7,9] | Main channel widths in px, top to bottom |
| `branchCore` / `branchGlow` | 1 / 3 | Branch widths in px |
| `branchesMin` / `branchesMax` | 2 / 5 | Number of branches |
| `autoMeanMaxMs` / `autoMeanMinMs` | 25000 / 3000 | Mean auto-strike interval range |
| `autoMinLevel` | 0.05 | Storm level below which auto mode is idle |

## How it works

- Bolts are built with `Cesium.PolylineCollection`, added per strike and removed when it ends.
- Animation runs on `scene.preRender`, registered only while a strike is active.
- Bolt top height is `weather.definition.cloudBase` minus local ground height.
- The flash is a full-screen `div` with CSS radial gradients, positioned using `SceneTransforms.wgs84ToWindowCoordinates`.
- No GeoFS internal function is overridden, and the weather, rendering and flight systems are left untouched.

## Known limitations

- The flash is a 2D screen overlay. It does not actually light the scene, clouds or terrain.
- Distant bolts are swallowed by GeoFS fog and visibility, so the default range is limited to about 1800 m. The visible range depends on weather; tune it with `visFactor`.
- The unit and datum of `cloudBase` are assumed to be meters, which is not confirmed by official documentation.
- Not implemented yet: thunder with distance-based delay, lighting of the clouds themselves, compatibility testing with other weather add-ons.
- Not yet integrated into the official Options panel.

## Troubleshooting

1. Press F12, open the Console, and filter by `[GeoFSLightning]`.
2. Run `GeoFSLightning.probe()` to check that `Cesium`, `geofs.api.viewer` and `weather.definition.*` are available. Include the table in bug reports.
3. If no button or panel appears: make sure the Tampermonkey script is enabled, reload the page, and run `typeof GeoFSLightning` to check it loaded.
4. If you see the flash but no bolt, it is most likely hidden by fog at distance. Try `GeoFSLightning.cfg.maxDist = 1200; GeoFSLightning.strike()`.
5. If the toolbar button shows the text `flash_on` instead of an icon, the Material Icons font is not loaded. Please report it.

## Compatibility

Tested on a GeoFS build running Cesium 1.96.

## References

- GeoFS type definitions: <https://github.com/gpsystem/geofs-types>
