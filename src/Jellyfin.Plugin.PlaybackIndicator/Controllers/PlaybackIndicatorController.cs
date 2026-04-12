using System;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Jellyfin.Plugin.PlaybackIndicator.Configuration;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.PlaybackIndicator.Controllers;

/// <summary>
/// Handles plugin settings and exposes playback info calculation API.
/// </summary>
[ApiController]
[Route("Plugin/PlaybackIndicator")]
[Authorize]
public class PlaybackIndicatorController : ControllerBase
{
    private readonly PlaybackInfoService _playbackInfoService;
    private readonly ILogger<PlaybackIndicatorController> _logger;

    public PlaybackIndicatorController(
        PlaybackInfoService playbackInfoService,
        ILogger<PlaybackIndicatorController> logger)
    {
        _playbackInfoService = playbackInfoService;
        _logger = logger;
    }

    /// <summary>
    /// GET Plugin/PlaybackIndicator/Settings — returns current plugin configuration.
    /// </summary>
    [HttpGet("Settings")]
    public ActionResult<PluginConfiguration> GetSettings()
    {
        return Ok(Plugin.Instance?.Configuration ?? new PluginConfiguration());
    }

    /// <summary>
    /// POST Plugin/PlaybackIndicator/Settings — saves plugin configuration.
    /// </summary>
    [HttpPost("Settings")]
    public ActionResult SaveSettings([FromBody] PluginConfiguration config)
    {
        if (Plugin.Instance is null)
            return Unauthorized();

        Plugin.Instance.UpdateConfiguration(config);
        _logger.LogInformation("Plugin configuration updated.");
        return Ok();
    }

    // Desktop browsers that need MKV remuxed to MP4.
    // Mobile/native apps can direct-play MKV containers natively.
    private static readonly Regex DesktopBrowserPattern = new(
        @"(Windows|Macintosh|X11|Linux).*?(Chrome|Firefox|Safari|Edg|OPR|Opera|Brave)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // Patterns that indicate a native/mobile client (can direct-play MKV)
    private static readonly Regex NativeClientPattern = new(
        @"(Android|iPhone|iPad|iPod|CrKey|SmartTV|Tizen|webOS|Roku|AppleTV|AFT|BRAVIA|Dalvik|okhttp|Jellyfin\s+Mobile)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>
    /// Determines whether the requesting client is a desktop web browser
    /// (which cannot direct-play MKV and needs remuxing).
    /// </summary>
    private bool IsDesktopBrowser()
    {
        var ua = HttpContext.Request.Headers.UserAgent.ToString();
        if (string.IsNullOrEmpty(ua)) return true; // default to safe assumption

        // Native/mobile clients can direct-play MKV
        if (NativeClientPattern.IsMatch(ua)) return false;

        // Desktop browsers need MKV remuxed
        if (DesktopBrowserPattern.IsMatch(ua)) return true;

        // Unknown UA — assume desktop browser (safe default)
        return true;
    }

    /// <summary>
    /// GET Plugin/PlaybackIndicator/PlaybackStatus/{itemId}
    /// Calculates and returns the direct-play / transcode status for an item.
    /// </summary>
    [HttpGet("PlaybackStatus/{itemId}")]
    public async Task<ActionResult<PlaybackStatusResult>> GetPlaybackStatus(
        [FromRoute] string itemId)
    {
        var debugEnabled = Plugin.Instance?.Configuration.EnableDebugLogging == true;
        var isDesktopBrowser = IsDesktopBrowser();

        if (debugEnabled)
        {
            var ua = HttpContext.Request.Headers.UserAgent.ToString();
            _logger.LogDebug("PlaybackStatus request: ItemId={ItemId}, IsDesktopBrowser={IsDesktop}, UA={UA}",
                itemId, isDesktopBrowser, ua);
        }

        try
        {
            var result = await _playbackInfoService.GetPlaybackStatusAsync(
                itemId,
                HttpContext.RequestAborted,
                isDesktopBrowser).ConfigureAwait(false);

            if (debugEnabled)
            {
                _logger.LogDebug("PlaybackStatus result: ItemId={ItemId}, Status={Status}, Reason={Reason}",
                    itemId, result.Status, result.Reason);
            }

            return Ok(result);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting playback status for item {ItemId}", itemId);
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// GET Plugin/PlaybackIndicator/playback-indicator.js
    /// Serves the client-side badge-injection script as a plain JavaScript file.
    /// </summary>
    [HttpGet("playback-indicator.js")]
    [AllowAnonymous]
    public ActionResult GetPlaybackIndicatorJs()
    {
        var resourceName = "Jellyfin.Plugin.PlaybackIndicator.Web.playback-indicator.js";
        using var stream = typeof(PlaybackIndicatorController).Assembly
            .GetManifestResourceStream(resourceName);
        if (stream is null)
        {
            _logger.LogError("Embedded resource {Resource} not found.", resourceName);
            return NotFound(new { error = "playback-indicator.js not found as embedded resource" });
        }

        using var reader = new StreamReader(stream);
        var js = reader.ReadToEnd();
        _logger.LogDebug("Serving playback-indicator.js ({Length} bytes)", js.Length);
        return Content(js, "application/javascript");
    }
}
