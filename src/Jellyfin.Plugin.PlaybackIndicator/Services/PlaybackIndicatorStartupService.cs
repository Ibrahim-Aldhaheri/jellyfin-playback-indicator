using System;
using System.IO;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.PlaybackIndicator.Services;

/// <summary>
/// Handles injecting the playback-indicator JS loader into Jellyfin's index.html
/// so it loads on every page.
/// </summary>
public class PlaybackIndicatorStartupService
{
    private readonly IApplicationPaths _appPaths;

    public PlaybackIndicatorStartupService(IApplicationPaths appPaths)
    {
        _appPaths = appPaths;
    }

    /// <summary>
    /// Injects a &lt;script&gt; tag loading playback-indicator.js into index.html.
    /// Safe to call multiple times — checks for injection marker before modifying.
    /// </summary>
    public async Task InjectJsLoaderAsync()
    {
        // Try standard locations for index.html
        var indexPaths = new[]
        {
            Path.Combine(_appPaths.DataPath, "jellyfin-web", "index.html"),
            Path.Combine(_appPaths.DataPath, "web", "index.html"),
            "/usr/share/jellyfin/web/index.html",
            "C:\\ProgramData\\Jellyfin\\Server\\web\\index.html"
        };

        string? indexPath = null;
        foreach (var p in indexPaths)
        {
            if (File.Exists(p))
            {
                indexPath = p;
                break;
            }
        }

        if (indexPath is null)
        {
            Console.WriteLine(
                "[PlaybackIndicator] Could not find index.html in any known location.");
            return;
        }

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
                Console.WriteLine("[PlaybackIndicator] JS loader already injected, skipping.");
                return;
            }

            // Inject before </head>
            if (html.Contains("</head>"))
            {
                html = html.Replace("</head>", jsLoader + "\n</head>");
            }
            else if (html.Contains("</body>"))
            {
                html = html.Replace("</body>", jsLoader + "\n</body>");
            }
            else
            {
                Console.WriteLine("[PlaybackIndicator] Could not find </head> or </body> in index.html");
                return;
            }

            await File.WriteAllTextAsync(indexPath, html);
            Console.WriteLine($"[PlaybackIndicator] Injected JS loader into {indexPath}");
        }
        catch (UnauthorizedAccessException ex)
        {
            Console.WriteLine(
                $"[PlaybackIndicator] Access denied writing {indexPath}. "
                + "If running in Docker, map index.html as a volume: "
                + "- /path/to/your/jellyfin/config/index.html:/usr/share/jellyfin/web/index.html. "
                + $"Error: {ex.Message}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[PlaybackIndicator] Failed to inject JS loader into {indexPath}: {ex.Message}");
        }
    }
}
