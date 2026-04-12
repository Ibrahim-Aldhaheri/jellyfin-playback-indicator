using System.IO;
using Jellyfin.Plugin.PlaybackIndicator.Configuration;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.PlaybackIndicator.Controllers;

/// <summary>
/// Handles plugin settings and serves the client-side JS.
/// Playback detection is done client-side via Jellyfin's built-in PlaybackInfo API.
/// </summary>
[ApiController]
[Route("Plugin/PlaybackIndicator")]
[Authorize]
public class PlaybackIndicatorController : ControllerBase
{
    private readonly ILogger<PlaybackIndicatorController> _logger;

    public PlaybackIndicatorController(ILogger<PlaybackIndicatorController> logger)
    {
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
