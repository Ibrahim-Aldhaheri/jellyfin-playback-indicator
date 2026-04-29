# Playback Indicator

A Jellyfin server plugin that injects direct-play / transcode status badges on episode and movie rows in the Jellyfin web UI.

## Features

- Shows ✅ green badge for direct-play-eligible items
- Shows ⚠️ amber badge for items that will require transcoding
- Per-item caching with 1-hour TTL
- Hooks into Jellyfin's SPA router — survives page navigation

## Installation

1. Download the latest release from the [Releases page](https://github.com/badr-abokhalil-dev/jellyfin-playback-indicator/releases)
2. In Jellyfin Dashboard → Plugins → Catalog → ⚙️ → Install from zip
3. Restart Jellyfin

## How It Works

The plugin's client-side JavaScript watches the DOM via `MutationObserver`. When new media cards or list rows appear, it:

1. Filters out non-playable items (series, seasons, collections, people, etc.) using `data-type` attributes and a cached type lookup
2. Calls `POST /Items/{id}/PlaybackInfo` for each playable item, using a real device profile
3. Translates the server's `SupportsDirectPlay` / `SupportsDirectStream` / `SupportsTranscoding` decision into a badge

**Device profile accuracy:** instead of inventing a synthetic profile (which the original 0.3.x line did, and which is always wrong in some way), v0.4.0 hooks `XMLHttpRequest` and captures the *real* `DeviceProfile` that the Jellyfin web client sends the first time you actually start playback. Subsequent prediction calls reuse that profile, so the prediction matches what playback would actually do. Until the first real play happens, a permissive synthetic fallback is used.

Results are cached in `localStorage` keyed by `itemId + userId + deviceId + codec-fingerprint` for 1 hour. Item types are cached for 24 hours.

## Building from Source

```bash
cd Jellyfin.Plugin.PlaybackIndicator
dotnet restore
dotnet build
```

The built `.zip` will be in `bin/Debug/net9.0/publish/`.

## Plugin Configuration

Settings are available in **Dashboard → Plugins → Playback Indicator**:

- **Cache TTL (minutes)**: How long to cache playback info per item (default: 60)
- **Show badge on movies**: Toggle movie library badges (default: on)
- **Show badge on episodes**: Toggle episode list badges (default: on)

## Badge Reference

| Status | Color | Meaning |
|--------|-------|---------|
| ✅ Direct Play | Green | File sent as-is — container, video, and audio all native to the device |
| 🔁 Re-mux | Blue | Container repackaged but video AND audio kept native — lossless, very low CPU on the server |
| ⚠️ Direct Stream | Amber | Video kept native, audio gets transcoded |
| ❌ Transcode | Red | Video re-encoded (and possibly audio too); most CPU-expensive |

### A note on Direct Stream detection

In v0.3.x the plugin overrode the server's decision for *any* MKV/AVI/OGV/FLV container, marking everything as Transcode. v0.4.0 trusts the server's flags by default and only overrides for audio codecs that genuinely fail in browser players (TrueHD/MLP). DTS and other formats are now reported as the server reports them, since with a real captured device profile the server's decision is accurate.

## Tech Stack

- C# .NET 9
- Jellyfin 10.11+ plugin APIs
- Vanilla JavaScript (no framework dependencies)
