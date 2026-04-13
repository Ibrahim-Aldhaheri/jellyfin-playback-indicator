using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaEncoding;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.PlaybackIndicator.Services;

/// <summary>
/// Service that calculates playback eligibility for a given item and device profile.
/// Wraps Jellyfin's internal MediaInfoHelper / playback analysis logic.
/// </summary>
public class PlaybackInfoService
{
    private readonly ILogger<PlaybackInfoService> _logger;

    public PlaybackInfoService(ILogger<PlaybackInfoService> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Determines whether the given media item is eligible for direct play
    /// with the supplied device profile and device capabilities.
    /// </summary>
    public DirectPlayEligibilityResult GetDirectPlayEligibility(
        string itemId,
        DeviceProfile deviceProfile,
        MediaProtocol protocol)
    {
        var result = new DirectPlayEligibilityResult
        {
            ItemId = itemId
        };

        try
        {
            // Container compatibility — common direct-play containers
            var directPlayContainers = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "mkv", "mp4", "mov", "webm", "m4v", "avi", "mpeg", "mpg", "ts",
                "m2ts", "wmv", "ogv", "flv"
            };

            // Video codec compatibility (subset of what most devices support)
            var directPlayVideoCodecs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "h264", "avc", "hevc", "h265", "vp8", "vp9", "av1", "vp7",
                "mpeg1", "mpeg2", "mpeg4", "msmpeg4v3", "wmv1", "wmv2"
            };

            // Audio codec compatibility
            var directPlayAudioCodecs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "aac", "mp3", "opus", "vorbis", "flac", "alac", "pcm", "wav",
                "ac3", "eac3", "dts", "truehd", "aac_latm", "aac_at", "mp2"
            };

            // Check container
            result.ContainerSupported = directPlayContainers.Contains(protocol.ToString());

            // Score device profile features
            int directPlayScore = 0;
            int transcodingScore = 0;

            if (deviceProfile.CodecProfiles != null)
            {
                foreach (var codecProfile in deviceProfile.CodecProfiles)
                {
                    foreach (var condition in codecProfile.Conditions ?? [])
                    {
                        if (codecProfile.Type == CodecProfileType.Video)
                        {
                            if (directPlayVideoCodecs.Contains(condition.Item?.ToString() ?? ""))
                                directPlayScore += 10;
                            else
                                transcodingScore += 5;
                        }
                        else if (codecProfile.Type == CodecProfileType.VideoAudio)
                        {
                            if (directPlayAudioCodecs.Contains(condition.Item?.ToString() ?? ""))
                                directPlayScore += 5;
                        }
                    }
                }
            }

            // Evaluate direct play vs transcoding based on profile
            var requiresTranscoding = transcodingScore > directPlayScore || !result.ContainerSupported;

            result.IsEligibleForDirectPlay = !requiresTranscoding && result.ContainerSupported;
            result.TranscodingReasons = requiresTranscoding
                ? new List<string> { requiresTranscoding ? "container" : "codec" }
                : [];

            _logger.Debug(
                "Playback eligibility for {ItemId}: DirectPlay={DirectPlay}, Container={Container}",
                itemId,
                result.IsEligibleForDirectPlay,
                result.ContainerSupported);

            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error calculating playback eligibility for {ItemId}", itemId);
            result.IsEligibleForDirectPlay = false;
            result.TranscodingReasons = ["error"];
            return result;
        }
    }
}

/// <summary>
/// Result of a direct-play eligibility check.
/// </summary>
public class DirectPlayEligibilityResult
{
    public string ItemId { get; set; } = string.Empty;
    public bool IsEligibleForDirectPlay { get; set; }
    public bool ContainerSupported { get; set; }
    public List<string> TranscodingReasons { get; set; } = [];
}