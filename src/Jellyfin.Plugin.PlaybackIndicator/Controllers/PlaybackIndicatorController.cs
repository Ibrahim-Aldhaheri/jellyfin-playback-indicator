using System;
using System.IO;
using System.Threading.Tasks;
using Jellyfin.Plugin.PlaybackIndicator.Configuration;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Session;
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
    private readonly IServerApplicationPaths _appPaths;
    private readonly PlaybackInfoService _playbackInfoService;
    private readonly ILogger<PlaybackIndicatorController> _logger;

    public PlaybackIndicatorController(
        IServerApplicationPaths appPaths,
        PlaybackInfoService playbackInfoService,
        ILogger<PlaybackIndicatorController> logger)
    {
        _appPaths = appPaths;
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

    /// <summary>
    /// GET Plugin/PlaybackIndicator/PlaybackStatus/{itemId}
    /// Calculates and returns the direct-play / transcode status for an item.
    /// </summary>
    [HttpGet("PlaybackStatus/{itemId}")]
    public async Task<ActionResult<PlaybackStatusResult>> GetPlaybackStatus(
        [FromRoute] string itemId,
        [FromQuery] string? deviceId = null)
    {
        var devId = deviceId
            ?? Request.Headers["X-Emby-Client-Device-Id"].ToString()
            ?? string.Empty;

        var debugEnabled = Plugin.Instance?.Configuration.EnableDebugLogging == true;
        if (debugEnabled)
        {
            _logger.LogDebug("PlaybackStatus request: ItemId={ItemId}, DeviceId={DeviceId}", itemId, devId);
        }

        try
        {
            var result = await _playbackInfoService.GetPlaybackStatusAsync(
                itemId,
                devId,
                Request.Headers,
                HttpContext.RequestAborted).ConfigureAwait(false);

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
