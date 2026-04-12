using System;
using System.IO;
using System.Threading.Tasks;
using Jellyfin.Plugin.PlaybackIndicator.Configuration;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

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

    public PlaybackIndicatorController(
        IServerApplicationPaths appPaths,
        PlaybackInfoService playbackInfoService)
    {
        _appPaths = appPaths;
        _playbackInfoService = playbackInfoService;
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

        try
        {
            var result = await _playbackInfoService.GetPlaybackStatusAsync(
                itemId,
                devId,
                Request.Headers,
                HttpContext.RequestAborted).ConfigureAwait(false);

            return Ok(result);
        }
        catch (Exception ex)
        {
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
        var ns = typeof(PlaybackIndicatorController).Namespace;
        var resourceName = $"{ns}.Web.playback-indicator.js";
        using var stream = typeof(PlaybackIndicatorController).Assembly
            .GetManifestResourceStream(resourceName);
        if (stream is null)
            return NotFound(new { error = "playback-indicator.js not found as embedded resource" });

        using var reader = new StreamReader(stream);
        var js = reader.ReadToEnd();
        return Content(js, "application/javascript");
    }
}
