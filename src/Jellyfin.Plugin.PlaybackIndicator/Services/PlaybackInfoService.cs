using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.PlaybackIndicator;

/// <summary>
/// Determines direct-play / transcode status for a media item using
/// Jellyfin's internal library and media-source APIs (no HTTP calls).
/// </summary>
public class PlaybackInfoService
{
    private readonly ILibraryManager _libraryManager;
    private readonly IMediaSourceManager _mediaSourceManager;
    private readonly ILogger<PlaybackInfoService> _logger;

    /// <summary>
    /// Codecs that virtually all Jellyfin web clients can direct-play.
    /// </summary>
    private static readonly HashSet<string> CommonDirectPlayVideoCodecs = new(StringComparer.OrdinalIgnoreCase)
    {
        "h264", "avc", "avc1"
    };

    private static readonly HashSet<string> CommonDirectPlayAudioCodecs = new(StringComparer.OrdinalIgnoreCase)
    {
        "aac", "mp3", "ac3", "eac3", "flac", "opus", "vorbis"
    };

    private static readonly HashSet<string> CommonDirectPlayContainers = new(StringComparer.OrdinalIgnoreCase)
    {
        "mp4", "mkv", "webm", "mov", "m4v"
    };

    /// <summary>
    /// Codecs that many modern clients support but may transcode on some.
    /// </summary>
    private static readonly HashSet<string> ExtendedVideoCodecs = new(StringComparer.OrdinalIgnoreCase)
    {
        "hevc", "h265", "hev1", "hvc1", "vp9", "av1"
    };

    public PlaybackInfoService(
        ILibraryManager libraryManager,
        IMediaSourceManager mediaSourceManager,
        ILogger<PlaybackInfoService> logger)
    {
        _libraryManager = libraryManager;
        _mediaSourceManager = mediaSourceManager;
        _logger = logger;
    }

    /// <summary>
    /// Gets playback status for an item by inspecting its media sources directly.
    /// </summary>
    public Task<PlaybackStatusResult> GetPlaybackStatusAsync(
        string itemId,
        CancellationToken cancellationToken)
    {
        var debugEnabled = Plugin.Instance?.Configuration.EnableDebugLogging == true;

        if (debugEnabled)
            _logger.LogInformation("[PlaybackIndicator] Checking playback status for item {ItemId}", itemId);

        try
        {
            if (!Guid.TryParse(itemId, out var itemGuid))
            {
                return Task.FromResult(new PlaybackStatusResult
                {
                    ItemId = itemId,
                    Status = PlaybackStatus.Unknown,
                    Reason = "Invalid item ID"
                });
            }

            var item = _libraryManager.GetItemById(itemGuid);
            if (item is null)
            {
                return Task.FromResult(new PlaybackStatusResult
                {
                    ItemId = itemId,
                    Status = PlaybackStatus.Unknown,
                    Reason = "Item not found"
                });
            }

            // Get media sources from the internal API — no HTTP round-trip
            var mediaSources = _mediaSourceManager.GetStaticMediaSources(item, true);

            if (debugEnabled)
                _logger.LogInformation("[PlaybackIndicator] Item {ItemId}: found {Count} media source(s)", itemId, mediaSources.Count);

            if (mediaSources.Count == 0)
            {
                return Task.FromResult(new PlaybackStatusResult
                {
                    ItemId = itemId,
                    Status = PlaybackStatus.Unknown,
                    Reason = "No media source found"
                });
            }

            var source = mediaSources[0];
            var videoStream = source.MediaStreams?.FirstOrDefault(s => s.Type == MediaStreamType.Video);
            var audioStream = source.MediaStreams?.FirstOrDefault(s => s.Type == MediaStreamType.Audio && s.IsDefault)
                           ?? source.MediaStreams?.FirstOrDefault(s => s.Type == MediaStreamType.Audio);

            var videoCodec = videoStream?.Codec ?? string.Empty;
            var audioCodec = audioStream?.Codec ?? string.Empty;
            var container = source.Container ?? string.Empty;

            // Determine playback status based on codec/container compatibility
            var reasons = new List<string>();

            if (!string.IsNullOrEmpty(videoCodec) && !CommonDirectPlayVideoCodecs.Contains(videoCodec) && !ExtendedVideoCodecs.Contains(videoCodec))
                reasons.Add($"VideoCodecNotSupported ({videoCodec})");

            if (!string.IsNullOrEmpty(audioCodec) && !CommonDirectPlayAudioCodecs.Contains(audioCodec))
                reasons.Add($"AudioCodecNotSupported ({audioCodec})");

            if (!string.IsNullOrEmpty(container) && !CommonDirectPlayContainers.Contains(container))
                reasons.Add($"ContainerNotSupported ({container})");

            // H265/HEVC and other extended codecs: mark as MayTranscode
            bool videoIsExtendedOnly = !string.IsNullOrEmpty(videoCodec)
                && !CommonDirectPlayVideoCodecs.Contains(videoCodec)
                && ExtendedVideoCodecs.Contains(videoCodec);

            PlaybackStatus status;
            if (reasons.Count == 0 && !videoIsExtendedOnly)
            {
                status = PlaybackStatus.DirectPlay;
            }
            else if (reasons.Count == 0 && videoIsExtendedOnly)
            {
                // Extended codec (hevc, vp9, av1) — many clients handle it, but not all
                status = PlaybackStatus.DirectPlay;
                reasons.Add($"ExtendedCodec ({videoCodec}) — most clients direct-play this");
            }
            else
            {
                status = PlaybackStatus.WillTranscode;
            }

            if (debugEnabled)
                _logger.LogInformation(
                    "[PlaybackIndicator] Item {ItemId}: Video={VideoCodec}, Audio={AudioCodec}, Container={Container}, Status={Status}, Reasons=[{Reasons}]",
                    itemId, videoCodec, audioCodec, container, status, string.Join(", ", reasons));

            return Task.FromResult(new PlaybackStatusResult
            {
                ItemId = itemId,
                Status = status,
                Reason = string.Join(", ", reasons),
                DirectPlayEligible = status == PlaybackStatus.DirectPlay,
                DirectStreamEligible = source.SupportsDirectStream,
                Container = container,
                AudioCodec = audioCodec,
                VideoCodec = videoCodec,
                TranscodingReasons = reasons
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[PlaybackIndicator] Error calculating playback status for {ItemId}", itemId);
            return Task.FromResult(new PlaybackStatusResult
            {
                ItemId = itemId,
                Status = PlaybackStatus.Unknown,
                Reason = ex.Message
            });
        }
    }
}

// ─── Result types ────────────────────────────────────────────────────────

public class PlaybackStatusResult
{
    public string ItemId { get; set; } = string.Empty;
    public PlaybackStatus Status { get; set; }
    public string Reason { get; set; } = string.Empty;
    public bool DirectPlayEligible { get; set; }
    public bool DirectStreamEligible { get; set; }
    public string? Container { get; set; }
    public string? AudioCodec { get; set; }
    public string? VideoCodec { get; set; }
    public List<string> TranscodingReasons { get; set; } = [];
}

public enum PlaybackStatus
{
    Unknown,
    DirectPlay,
    DirectStream,
    WillTranscode,
    Transcoding
}
