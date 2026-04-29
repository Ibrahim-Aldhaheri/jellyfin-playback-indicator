using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.PlaybackIndicator.Controllers;

/// <summary>
/// Serves the playback-indicator.js script via an API endpoint. Responses
/// are marked no-store so a stale script can never linger in the browser
/// after the plugin is uninstalled or upgraded.
/// </summary>
[ApiController]
[Route("PlaybackIndicator")]
public class PlaybackIndicatorController : ControllerBase
{
    [HttpGet("script.js")]
    [Produces("application/javascript")]
    [AllowAnonymous]
    public ActionResult GetScript()
    {
        Response.Headers[HeaderNames.CacheControl] = "no-store, no-cache, must-revalidate";
        Response.Headers[HeaderNames.Pragma] = "no-cache";

        var assembly = Assembly.GetExecutingAssembly();
        var resourceName = $"{typeof(Plugin).Namespace}.Web.playback-indicator.js";

        using var stream = assembly.GetManifestResourceStream(resourceName);
        if (stream == null)
        {
            return Content("/* PlaybackIndicator: script resource not found */", "application/javascript");
        }

        using var reader = new StreamReader(stream);
        return Content(reader.ReadToEnd(), "application/javascript");
    }
}
