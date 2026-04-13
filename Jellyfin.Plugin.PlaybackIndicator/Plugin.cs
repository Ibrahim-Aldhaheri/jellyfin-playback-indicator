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
/// Playback Indicator plugin — injects direct-play/stream/transcode badges.
/// JS is served via /PlaybackIndicator/script.js API controller.
/// Only a small script tag is injected into index.html.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    private readonly IApplicationPaths _appPaths;
    private readonly ILogger<Plugin> _logger;

    private const string StartComment = "<!-- BEGIN PlaybackIndicator -->";
    private const string EndComment = "<!-- END PlaybackIndicator -->";

    public Plugin(
        IApplicationPaths applicationPaths,
        IXmlSerializer xmlSerializer,
        ILogger<Plugin> logger)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        _appPaths = applicationPaths;
        _logger = logger;

        InjectLoader();
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Playback Indicator";

    public override Guid Id => Guid.Parse("b6f3e2a1-d4c5-4e7a-8b3f-9e2d1c0a8b5e");

    public override string Description => "Shows direct-play / direct-stream / transcode badges on items in the Jellyfin web UI.";

    private string IndexHtmlPath => Path.Combine(_appPaths.WebPath, "index.html");

    /// <summary>
    /// Inject a small script tag into index.html that loads our JS from the API controller.
    /// </summary>
    private void InjectLoader()
    {
        var indexPath = IndexHtmlPath;
        if (!File.Exists(indexPath))
        {
            _logger.LogError("Could not find index.html at: {Path}", indexPath);
            return;
        }

        try
        {
            var scriptTag = "<script src=\"/PlaybackIndicator/script.js\" defer></script>";
            var injectionBlock = $"{StartComment}\n{scriptTag}\n{EndComment}";

            var content = File.ReadAllText(indexPath);

            // Remove old block if exists (handles re-injection / updates)
            var regex = new Regex(
                $"{Regex.Escape(StartComment)}[\\s\\S]*?{Regex.Escape(EndComment)}",
                RegexOptions.Multiline);
            var newContent = regex.Replace(content, string.Empty);

            if (newContent != content || !content.Contains(StartComment))
            {
                var closingBody = "</body>";
                if (newContent.Contains(closingBody))
                {
                    newContent = newContent.Replace(closingBody, $"{injectionBlock}\n{closingBody}");
                    File.WriteAllText(indexPath, newContent);
                    _logger.LogInformation("Playback Indicator loader injected into index.html");
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error injecting Playback Indicator loader");
        }
    }

    /// <summary>
    /// Remove our script block from index.html on uninstall.
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
            var regex = new Regex(
                $"{Regex.Escape(StartComment)}[\\s\\S]*?{Regex.Escape(EndComment)}\\s*",
                RegexOptions.Multiline);
            if (regex.IsMatch(content))
            {
                content = regex.Replace(content, string.Empty);
                File.WriteAllText(indexPath, content);
                _logger.LogInformation("Playback Indicator loader removed from index.html on uninstall");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error removing Playback Indicator loader during uninstall");
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
