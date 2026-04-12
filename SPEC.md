# Jellyfin Playback Indicator Plugin — SPEC

## Overview

A Jellyfin server plugin that injects direct-play / transcode status badges on episode and movie rows in the Jellyfin web UI. Badges are auto-calculated from the **current device's actual playback capabilities** on page load — no manual profile configuration required.

## How It Works

1. User opens a series/season or movie library page in Jellyfin
2. The plugin's client-side code detects the page (SPA router hook)
3. It reads the current device/client identity from Jellyfin's session context
4. For each item row, it calls the Jellyfin `GetPostedPlaybackInfo` API with the device's playback profile headers
5. Jellyfin responds with which streams would be transcoded vs direct-played
6. The plugin injects a small colored badge on each row: ✅ Direct Play / ⚠️ Will Transcode / 🔄 Transcoding
7. Results are cached in `localStorage` to avoid re-querying on every navigation

## Architecture

### Server Side (C# .NET Plugin)
- Implements `BasePlugin<PluginConfiguration>` from Jellyfin's plugin SDK
- Provides a `PlaybackInfoService` that can be called from the client
- Configuration page (optional): toggle badge visibility, set cache TTL

### Client Side (JavaScript Injection)
- Hooks into Jellyfin's SPA router to detect series/movie page loads
- Uses Jellyfin's existing API client (`jellyfin-apiclient-python` / fetch) to call `GetPostedPlaybackInfo`
- Reads device context from `AppStorage` / session cookies
- Injects badge DOM elements into episode/movie list rows
- Caches results keyed by `itemId + deviceId`

## Badge Definitions

| Status | Color | Meaning |
|--------|-------|---------|
| ✅ Direct Play | Green | Container, video, audio, subtitles all compatible — no transcoding needed |
| ⚠️ Will Transcode | Amber | One or more streams will be transcoded (codec/container/bitrate) |
| 🔄 Transcoding | Red | Currently transcoding during playback |

## API Details

### Endpoint
```
POST /Items/{itemId}/PlaybackInfo
Headers:
  X-Emby-Authorization: ...
  X-Media-Budget-Bytes: ...
Body (PlaybackInfoRequest):
  DeviceId: string
  DeviceProfile: DeviceProfile (auto-detected from client headers)
```

### Response Parsing
```csharp
public class PlaybackInfoResponse {
    MediaSource[] PlaybackSources;
    TranscodingReason[] TranscodingReasons; // if non-empty = will transcode
    bool IsEligibleForDirectPlay;
    bool IsEligibleForDirectStream;
}
```

## UI Integration

### Target Elements
- TV Shows → Season page: episode list rows (`.episodeItem`, `paper-item[data-id]`)
- Movie library: card items (`.card`, `[data-id]`)
- Plugin must survive page navigation (SPA, no full reload)

### Badge Placement
- Injects as a small inline badge after the episode/movie name
- Small text, color-coded, non-intrusive

## Caching

- Key: `jpi_cache_{itemId}_{deviceId}`
- TTL: configurable, default 1 hour
- Invalidated when: user plays item (real playback data is more accurate)

## Out of Scope (v1)

- Telegram notifications (out of scope per sir)
- Playback history / reporting
- Plugin configuration UI (defaults are fine for v1)

## Tech Stack

- **Language**: C# (.NET 9, matching Jellyfin plugin template)
- **Client**: Vanilla JS injection (no framework needed)
- **API**: Jellyfin's native `MediaInfoController.GetPostedPlaybackInfo`
- **Install**: Published as `.zip`, install via Jellyfin Dashboard → Plugins → Catalog

## Reference Plugins

- `jellyfin-plugin-template` — official .NET plugin template
- `n00bcodr/Jellyfin-JavaScript-Injector` — JS injection pattern into Jellyfin web UI
- `jellyfin/jellyfin-plugin-webhook` — plugin structure for event handling

## Development Notes

- Jellyfin version target: **10.11+** (current stable)
- Plugin must survive Jellyfin updates — use official plugin APIs only
- The `GetPostedPlaybackInfo` endpoint is the same one Jellyfin's web client calls internally on playback — no new APIs needed