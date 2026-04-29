using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.PlaybackIndicator.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.PlaybackIndicator;

/// <summary>
/// Playback Indicator plugin — injects a small loader script into index.html
/// that pulls the badge logic from /PlaybackIndicator/script.js. All file IO
/// is wrapped so a write failure can never abort plugin loading.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    private const string StartMarker = "<!-- BEGIN PlaybackIndicator -->";
    private const string EndMarker = "<!-- END PlaybackIndicator -->";
    private const string ScriptTag = "<script src=\"/PlaybackIndicator/script.js\" defer></script>";

    // Matches our current marker block AND any legacy variants left over from
    // older plugin versions. Used during both inject (clean before write) and
    // uninstall (full removal).
    private static readonly Regex InjectionBlockRegex = new(
        @"<!--\s*BEGIN\s+PlaybackIndicator\s*-->[\s\S]*?<!--\s*END\s+PlaybackIndicator\s*-->\s*",
        RegexOptions.Multiline | RegexOptions.IgnoreCase);

    private readonly IApplicationPaths _appPaths;
    private readonly ILogger<Plugin> _logger;

    public Plugin(
        IApplicationPaths applicationPaths,
        IXmlSerializer xmlSerializer,
        ILogger<Plugin> logger)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        _appPaths = applicationPaths;
        _logger = logger;

        try
        {
            InjectLoader();
        }
        catch (Exception ex)
        {
            // Never let an injection problem prevent the plugin (or Jellyfin)
            // from loading. The badges simply won't appear until next restart.
            _logger.LogWarning(ex, "Playback Indicator: loader injection failed (non-fatal)");
        }
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Playback Indicator";

    public override Guid Id => Guid.Parse("b6f3e2a1-d4c5-4e7a-8b3f-9e2d1c0a8b5e");

    public override string Description => "Shows direct-play / direct-stream / transcode badges on items in the Jellyfin web UI.";

    private string IndexHtmlPath => Path.Combine(_appPaths.WebPath, "index.html");

    /// <summary>
    /// Idempotently inject the loader script into index.html. If the file
    /// doesn't exist, isn't writable, or anything else goes wrong, log and
    /// return without throwing.
    /// </summary>
    private void InjectLoader()
    {
        var indexPath = IndexHtmlPath;
        if (!File.Exists(indexPath))
        {
            _logger.LogWarning("Playback Indicator: index.html not found at {Path}; skipping injection", indexPath);
            return;
        }

        string content;
        try
        {
            content = File.ReadAllText(indexPath);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Playback Indicator: cannot read index.html; skipping injection");
            return;
        }

        // Strip every existing block (handles re-runs and old marker variants).
        var stripped = InjectionBlockRegex.Replace(content, string.Empty);

        const string closingBody = "</body>";
        var closeIdx = stripped.LastIndexOf(closingBody, StringComparison.OrdinalIgnoreCase);
        if (closeIdx < 0)
        {
            _logger.LogWarning("Playback Indicator: index.html has no </body>; skipping injection");
            return;
        }

        var block = $"{StartMarker}\n{ScriptTag}\n{EndMarker}\n";
        var newContent = stripped.Insert(closeIdx, block);

        if (newContent == content)
        {
            return; // already correct, nothing to do
        }

        if (!TryAtomicWrite(indexPath, newContent, out var writeError))
        {
            _logger.LogWarning(writeError, "Playback Indicator: failed to update index.html");
            return;
        }

        _logger.LogInformation("Playback Indicator: loader injected into {Path}", indexPath);
    }

    /// <summary>
    /// Remove our script block (and any legacy variants) from index.html on
    /// uninstall. Failure is logged but never thrown.
    /// </summary>
    public override void OnUninstalling()
    {
        var indexPath = IndexHtmlPath;
        if (!File.Exists(indexPath))
        {
            return;
        }

        try
        {
            var content = File.ReadAllText(indexPath);
            if (!InjectionBlockRegex.IsMatch(content))
            {
                return;
            }

            var stripped = InjectionBlockRegex.Replace(content, string.Empty);
            if (TryAtomicWrite(indexPath, stripped, out var writeError))
            {
                _logger.LogInformation("Playback Indicator: loader removed from {Path}", indexPath);
            }
            else
            {
                _logger.LogWarning(writeError, "Playback Indicator: failed to remove loader on uninstall");
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Playback Indicator: error removing loader on uninstall");
        }
    }

    /// <summary>
    /// Write atomically by writing to a sibling temp file, then moving it
    /// into place. Avoids leaving index.html half-written if the process or
    /// disk fails mid-write.
    /// </summary>
    private static bool TryAtomicWrite(string path, string content, out Exception? error)
    {
        error = null;
        var tmp = path + ".jpi.tmp";
        try
        {
            File.WriteAllText(tmp, content);
            File.Move(tmp, path, overwrite: true);
            return true;
        }
        catch (Exception ex)
        {
            error = ex;
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
            return false;
        }
    }

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        return
        [
            new PluginPageInfo
            {
                Name = Name,
                EmbeddedResourcePath = $"{GetType().Namespace}.Configuration.configPage.html"
            }
        ];
    }
}
