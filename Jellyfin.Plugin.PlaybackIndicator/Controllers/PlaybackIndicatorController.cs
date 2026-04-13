using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.PlaybackIndicator.Controllers;

/// <summary>
/// Serves the playback-indicator.js script via an API endpoint.
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
