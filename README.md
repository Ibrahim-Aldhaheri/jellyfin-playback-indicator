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

The plugin's client-side JavaScript hooks into Jellyfin's SPA router. When you visit a series season page or movie library page, it:

1. Reads the current device playback profile from your active Jellyfin session
2. For each episode/movie row, calls `POST /Items/{id}/PlaybackInfo` with your device profile
3. Jellyfin responds with `IsEligibleForDirectPlay` + `TranscodingReasons`
4. Injects a colored badge next to the item name

Badges are cached in `localStorage` keyed by `itemId + deviceId` for 1 hour to avoid hammering the API on every navigation.

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
| ✅ Direct Play | Green | Container, video codec, audio codec, subtitles all compatible — no transcoding |
| ⚠️ Will Transcode | Amber | One or more streams will be transcoded |

## Tech Stack

- C# .NET 9
- Jellyfin 10.11+ plugin APIs
- Vanilla JavaScript (no framework dependencies)
