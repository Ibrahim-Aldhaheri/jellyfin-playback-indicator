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
    /// Idempotently inject the loader script into index.html.
    /// </summary>
    private void InjectLoader()
    {
        TransformIndexHtml("inject", stripped =>
        {
            const string closingBody = "</body>";
            var closeIdx = stripped.LastIndexOf(closingBody, StringComparison.OrdinalIgnoreCase);
            if (closeIdx < 0)
            {
                _logger.LogWarning("Playback Indicator: index.html has no </body>; skipping injection");
                return null;
            }
            return stripped.Insert(closeIdx, $"{StartMarker}\n{ScriptTag}\n{EndMarker}\n");
        });
    }

    /// <summary>
    /// Remove our script block (and any legacy variants) from index.html on uninstall.
    /// </summary>
    public override void OnUninstalling()
    {
        TransformIndexHtml("uninject", stripped => stripped);
    }

    /// <summary>
    /// Read index.html, strip any prior injection block, hand the result to
    /// the transform, write the transform's output atomically. All IO and
    /// transform errors are logged but never thrown — file IO must never
    /// abort plugin loading.
    /// </summary>
    private void TransformIndexHtml(string verb, Func<string, string?> transform)
    {
        var indexPath = IndexHtmlPath;
        if (!File.Exists(indexPath))
        {
            _logger.LogWarning("Playback Indicator: index.html not found at {Path}; skipping {Verb}", indexPath, verb);
            return;
        }

        string original;
        try
        {
            original = File.ReadAllText(indexPath);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Playback Indicator: cannot read index.html; skipping {Verb}", verb);
            return;
        }

        var stripped = InjectionBlockRegex.Replace(original, string.Empty);
        var newContent = transform(stripped);
        if (newContent is null || newContent == original) return;

        if (TryAtomicWrite(indexPath, newContent, out var writeError))
        {
            _logger.LogInformation("Playback Indicator: index.html {Verb} succeeded ({Path})", verb, indexPath);
        }
        else
        {
            _logger.LogWarning(writeError, "Playback Indicator: index.html {Verb} failed", verb);
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
