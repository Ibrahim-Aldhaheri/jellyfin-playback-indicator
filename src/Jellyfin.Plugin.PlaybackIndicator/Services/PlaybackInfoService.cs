using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.PlaybackIndicator;

/// <summary>
/// Calculates direct-play / transcode status for a media item by calling
/// Jellyfin's own PlaybackInfo API from within the server.
/// </summary>
public class PlaybackInfoService
{
    private readonly IServerApplicationHost _appHost;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<PlaybackInfoService> _logger;

    public PlaybackInfoService(
        IServerApplicationHost appHost,
        IHttpClientFactory httpClientFactory,
        ILogger<PlaybackInfoService> logger)
    {
        _appHost = appHost;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    /// <summary>
    /// Calls Jellyfin's internal PlaybackInfo API to determine whether an item
    /// will direct-play or require transcoding on the given device.
    /// </summary>
    public async Task<PlaybackStatusResult> GetPlaybackStatusAsync(
        string itemId,
        string deviceId,
        IHeaderDictionary requestHeaders,
        CancellationToken cancellationToken)
    {
        var debugEnabled = Plugin.Instance?.Configuration.EnableDebugLogging == true;

        if (debugEnabled)
            _logger.LogInformation("[PlaybackIndicator] Checking playback status for item {ItemId}, device {DeviceId}", itemId, deviceId);

        try
        {
            // Determine the local server URL
            string serverUrl;
            try
            {
                serverUrl = _appHost.GetSmartApiUrl((System.Net.IPAddress?)null) ?? "http://localhost:8096";
            }
            catch
            {
                serverUrl = "http://localhost:8096";
            }

            if (string.IsNullOrEmpty(serverUrl))
                serverUrl = "http://localhost:8096";

            // Extract UserId from auth header
            var userId = string.Empty;
            if (requestHeaders.TryGetValue("X-Emby-Authorization", out var authHeader))
            {
                var authStr = authHeader.ToString();
                var userIdMatch = System.Text.RegularExpressions.Regex.Match(authStr, @"UserId=""?([a-f0-9\-]+)""?", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                if (userIdMatch.Success)
                    userId = userIdMatch.Groups[1].Value;
            }

            var apiUrl = $"{serverUrl}/Items/{itemId}/PlaybackInfo" +
                $"?UserId={userId}&MaxStreamingBitrate=140000000&MaxAudioBitrate=140000000";

            if (debugEnabled)
                _logger.LogInformation("[PlaybackIndicator] Calling PlaybackInfo API: {Url}", apiUrl);

            var client = _httpClientFactory.CreateClient(NamedClient.Default);

            // Build playback info request — same body the Jellyfin web client sends
            var requestBody = new PlaybackInfoRequest
            {
                DeviceId = deviceId,
                Client = "Jellyfin Web",
                EnableAutoStream = true,
                EnableDirectPlay = true,
                EnableDirectStream = true,
                EnableTranscoding = true,
                AllowAudioStreamCopy = true,
                AllowVideoStreamCopy = true
            };

            var apiRequest = new HttpRequestMessage(HttpMethod.Post, apiUrl)
            {
                Content = JsonContent(requestBody)
            };

            // Forward authorization and device headers
            if (requestHeaders.TryGetValue("X-Emby-Authorization", out var auth))
                apiRequest.Headers.TryAddWithoutValidation("X-Emby-Authorization", auth.ToString());
            if (requestHeaders.TryGetValue("X-Emby-Client", out var clientVer))
                apiRequest.Headers.TryAddWithoutValidation("X-Emby-Client", clientVer.ToString());
            apiRequest.Headers.TryAddWithoutValidation("X-Emby-Client-Device-Id", deviceId);

            var response = await client.SendAsync(apiRequest, cancellationToken).ConfigureAwait(false);
            var json = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

            if (debugEnabled)
                _logger.LogInformation("[PlaybackIndicator] PlaybackInfo API response ({StatusCode}): {Body}", response.StatusCode, json.Length > 500 ? json[..500] + "..." : json);

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("[PlaybackIndicator] PlaybackInfo API returned {StatusCode}: {Body}", response.StatusCode, json);
                return new PlaybackStatusResult
                {
                    ItemId = itemId,
                    Status = PlaybackStatus.Unknown,
                    Reason = $"API error: {response.StatusCode}"
                };
            }

            var playbackInfo = JsonSerializer.Deserialize<PlaybackInfoResponse>(json, JsonOptions);

            if (debugEnabled)
                _logger.LogInformation("[PlaybackIndicator] Deserialized: MediaSources count = {Count}", playbackInfo?.MediaSources?.Count ?? 0);

            var primarySource = playbackInfo?.MediaSources?.FirstOrDefault();
            if (primarySource is null)
            {
                return new PlaybackStatusResult
                {
                    ItemId = itemId,
                    Status = PlaybackStatus.Unknown,
                    Reason = "No media source found"
                };
            }

            var transcodingReasons = primarySource.TranscodingReasons ?? [];
            var isDirectPlay = primarySource.SupportsDirectPlay == true
                && (!transcodingReasons.Any());

            var status = isDirectPlay ? PlaybackStatus.DirectPlay
                : primarySource.SupportsDirectStream == true && !transcodingReasons.Any(r => r.Contains("Video", StringComparison.OrdinalIgnoreCase)) ? PlaybackStatus.DirectStream
                : transcodingReasons.Any() ? PlaybackStatus.WillTranscode
                : PlaybackStatus.Unknown;

            if (debugEnabled)
                _logger.LogInformation("[PlaybackIndicator] Item {ItemId}: SupportsDirectPlay={DirectPlay}, SupportsDirectStream={DirectStream}, TranscodeReasons=[{Reasons}], FinalStatus={Status}",
                    itemId, primarySource.SupportsDirectPlay, primarySource.SupportsDirectStream, string.Join(", ", transcodingReasons), status);

            return new PlaybackStatusResult
            {
                ItemId = itemId,
                Status = status,
                Reason = string.Join(", ", transcodingReasons),
                DirectPlayEligible = isDirectPlay,
                DirectStreamEligible = primarySource.SupportsDirectStream == true,
                Container = primarySource.Container,
                AudioCodec = primarySource.MediaStreams?
                    .FirstOrDefault(s => s.Type == MediaStreamType.Audio)?.Codec,
                VideoCodec = primarySource.MediaStreams?
                    .FirstOrDefault(s => s.Type == MediaStreamType.Video)?.Codec,
                TranscodingReasons = transcodingReasons.ToList()
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error calculating playback status for {ItemId}", itemId);
            return new PlaybackStatusResult
            {
                ItemId = itemId,
                Status = PlaybackStatus.Unknown,
                Reason = ex.Message
            };
        }
    }

    // ─── JSON Serialization ───────────────────────────────────────────────

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter() }
    };

    private static System.Net.Http.Json.JsonContent JsonContent(object value) =>
        System.Net.Http.Json.JsonContent.Create(value, options: JsonOptions);

    // ─── DTOs ─────────────────────────────────────────────────────────────

    internal class PlaybackInfoRequest
    {
        [JsonPropertyName("DeviceId")]
        public string DeviceId { get; set; } = string.Empty;

        [JsonPropertyName("Client")]
        public string Client { get; set; } = "Jellyfin Web";

        [JsonPropertyName("EnableAutoStream")]
        public bool EnableAutoStream { get; set; } = true;

        [JsonPropertyName("EnableDirectPlay")]
        public bool EnableDirectPlay { get; set; } = true;

        [JsonPropertyName("EnableDirectStream")]
        public bool EnableDirectStream { get; set; } = true;

        [JsonPropertyName("EnableTranscoding")]
        public bool EnableTranscoding { get; set; } = true;

        [JsonPropertyName("AllowAudioStreamCopy")]
        public bool AllowAudioStreamCopy { get; set; } = true;

        [JsonPropertyName("AllowVideoStreamCopy")]
        public bool AllowVideoStreamCopy { get; set; } = true;
    }

    internal class PlaybackInfoResponse
    {
        [JsonPropertyName("MediaSources")]
        public List<MediaSourceDto>? MediaSources { get; set; }
    }

    internal class MediaSourceDto
    {
        [JsonPropertyName("Id")]
        public string? Id { get; set; }

        [JsonPropertyName("Container")]
        public string? Container { get; set; }

        [JsonPropertyName("SupportsDirectPlay")]
        public bool SupportsDirectPlay { get; set; }

        [JsonPropertyName("SupportsDirectStream")]
        public bool SupportsDirectStream { get; set; }

        [JsonPropertyName("TranscodingReasons")]
        public List<string>? TranscodingReasons { get; set; }

        [JsonPropertyName("MediaStreams")]
        public List<MediaStreamDto>? MediaStreams { get; set; }
    }

    internal class MediaStreamDto
    {
        [JsonPropertyName("Type")]
        public MediaStreamType Type { get; set; }

        [JsonPropertyName("Codec")]
        public string? Codec { get; set; }
    }

    internal enum MediaStreamType
    {
        Video = 0,
        Audio = 1,
        Subtitle = 2
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
