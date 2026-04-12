using System;
using System.IO;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.PlaybackIndicator.Services;

/// <summary>
/// Handles injecting the playback-indicator JS loader into Jellyfin's index.html
/// so it loads on every page.
/// </summary>
public class PlaybackIndicatorStartupService
{
    private readonly IApplicationPaths _appPaths;
    private readonly ILogger<PlaybackIndicatorStartupService> _logger;

    public PlaybackIndicatorStartupService(IApplicationPaths appPaths, ILogger<PlaybackIndicatorStartupService> logger)
    {
        _appPaths = appPaths;
        _logger = logger;
    }

    /// <summary>
    /// Injects a &lt;script&gt; tag loading playback-indicator.js into index.html.
    /// Safe to call multiple times — checks for injection marker before modifying.
    /// </summary>
    public async Task InjectJsLoaderAsync()
    {
        // Try standard locations for index.html — Docker official image first
        var indexPaths = new[]
        {
            "/jellyfin/jellyfin-web/index.html",
            Path.Combine(_appPaths.DataPath, "jellyfin-web", "index.html"),
            Path.Combine(_appPaths.DataPath, "web", "index.html"),
            "/usr/share/jellyfin/web/index.html",
            "C:\\ProgramData\\Jellyfin\\Server\\web\\index.html"
        };

        string? indexPath = null;
        foreach (var p in indexPaths)
        {
            _logger.LogDebug("Checking for index.html at: {Path}", p);
            if (File.Exists(p))
            {
                indexPath = p;
                break;
            }
        }

        if (indexPath is null)
        {
            _logger.LogError(
                "Could not find index.html in any known location. Checked: {Paths}",
                string.Join(", ", indexPaths));
            return;
        }

        _logger.LogInformation("Found index.html at: {Path}", indexPath);

        var marker = "<!-- PlaybackIndicator:js-injected -->";
        var jsLoader = @"
<!-- PlaybackIndicator:js-injected -->
<script>
(function() {
    'use strict';
    var tag = document.createElement('script');
    tag.src = 'Plugin/PlaybackIndicator/playback-indicator.js';
    tag.defer = true;
    document.head.appendChild(tag);
})();
</script>";

        try
        {
            var html = await File.ReadAllTextAsync(indexPath);

            if (html.Contains(marker))
            {
                _logger.LogInformation("JS loader already injected in {Path}, skipping.", indexPath);
                return;
            }

            // Inject before </head>
            if (html.Contains("</head>"))
            {
                html = html.Replace("</head>", jsLoader + "\n</head>");
            }
            else if (html.Contains("</body>"))
            {
                _logger.LogWarning("No </head> tag found, injecting before </body> instead.");
                html = html.Replace("</body>", jsLoader + "\n</body>");
            }
            else
            {
                _logger.LogError("Could not find </head> or </body> in {Path}", indexPath);
                return;
            }

            await File.WriteAllTextAsync(indexPath, html);
            _logger.LogInformation("Successfully injected JS loader into {Path}", indexPath);
        }
        catch (UnauthorizedAccessException ex)
        {
            _logger.LogError(ex,
                "Access denied writing {Path}. If running in Docker, ensure the web directory is writable.",
                indexPath);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to inject JS loader into {Path}", indexPath);
        }
    }

    /// <summary>
    /// Removes the injected script tag from index.html (for cleanup/uninstall).
    /// </summary>
    public async Task RemoveJsLoaderAsync()
    {
        var marker = "<!-- PlaybackIndicator:js-injected -->";
        var indexPaths = new[]
        {
            "/jellyfin/jellyfin-web/index.html",
            Path.Combine(_appPaths.DataPath, "jellyfin-web", "index.html"),
            Path.Combine(_appPaths.DataPath, "web", "index.html"),
            "/usr/share/jellyfin/web/index.html",
            "C:\\ProgramData\\Jellyfin\\Server\\web\\index.html"
        };

        foreach (var p in indexPaths)
        {
            if (!File.Exists(p)) continue;

            try
            {
                var html = await File.ReadAllTextAsync(p);
                if (!html.Contains(marker)) continue;

                // Remove the entire injected block
                var startIdx = html.IndexOf("\n" + marker, StringComparison.Ordinal);
                if (startIdx < 0)
                    startIdx = html.IndexOf(marker, StringComparison.Ordinal);

                var endMarker = "</script>";
                var endIdx = html.IndexOf(endMarker, startIdx, StringComparison.Ordinal);
                if (endIdx > startIdx)
                {
                    html = html.Remove(startIdx, endIdx - startIdx + endMarker.Length);
                    await File.WriteAllTextAsync(p, html);
                    _logger.LogInformation("Removed JS loader injection from {Path}", p);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to remove JS loader from {Path}", p);
            }
        }
    }
}
