# Jellyfin Playback Indicator

A Jellyfin server plugin that shows **direct play / transcode status badges** directly on episode and movie rows in the Jellyfin web UI — auto-detected from your current device, no manual profile setup required.

## Features

- ✅ **Direct Play** — green badge: no transcoding needed
- ⚠️ **Will Transcode** — amber badge: codec/container/bitrate requires transcoding
- 💧 **Direct Stream** — blue badge: container remux but no transcoding
- ❓ **Unknown** — grey badge: could not determine status

Badges are calculated on page load based on **your actual device's playback capabilities** — the same logic Jellyfin uses internally when you hit play.

## How It Works

1. You open a series or movie library page in Jellyfin
2. The plugin detects the page (SPA router hook)
3. For each episode/movie row, it calls Jellyfin's `GetPostedPlaybackInfo` API with your device context
4. Jellyfin responds with direct-play eligibility and transcoding reasons
5. A small badge appears on each row

Results are cached for 1 hour per item to avoid hammering the API.

## Installation

### From Source (Recommended for Testing)

```bash
git clone https://github.com/badr-abokhalil-dev/jellyfin-playback-indicator.git
cd jellyfin-playback-indicator/src/Jellyfin.Plugin.PlaybackIndicator
dotnet publish -c Release -o /path/to/jellyfin/plugins/PlaybackIndicator
```

Then restart Jellyfin and enable the plugin from **Dashboard → Plugins**.

### From Plugin Catalog

> TBD — once the plugin is published to the official catalog.

## Configuration

Open **Dashboard → Playback Indicator** to configure:

- **Cache TTL** — how long to cache playback info per item (default: 1 hour)
- **Show on TV Shows** — toggle badges on episode lists
- **Show on Movies** — toggle badges on movie rows

## Tech Stack

- **C# .NET 9** — Jellyfin plugin SDK
- **Vanilla JS** — SPA router hooks + DOM injection
- **Jellyfin API** — uses `GetPostedPlaybackInfo` internally

## Compatibility

Tested with **Jellyfin 10.11+**.

## License

MIT
