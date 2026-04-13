using System;
using System.Collections.Generic;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.PlaybackIndicator;

/// <summary>
/// Main plugin class for Playback Indicator.
/// Injects direct-play / transcode badges into the Jellyfin web UI.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebResources, IHasWebPages
{
    private readonly IApplicationPaths _appPaths;

    /// <summary>
    /// Initializes a new instance of the <see cref="Plugin"/> class.
    /// </summary>
    /// <param name="applicationPaths">Instance of the <see cref="IApplicationPaths"/> interface.</param>
    /// <param name="xmlSerializer">Instance of the <see cref="IXmlSerializer"/> interface.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        _appPaths = applicationPaths;
    }

    /// <summary>
    /// Gets the current plugin instance.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public override string Name => "Playback Indicator";

    /// <inheritdoc />
    public override Guid Id => Guid.Parse("b6f3e2a1-d4c5-4e7a-8b3f-9e2d1c0a8b5e");

    /// <inheritdoc />
    public override string Description => "Shows direct-play / transcode status badges on episode and movie rows in the Jellyfin web UI.";

    /// <inheritdoc />
    public string GetWebResourceFileUrl(string name)
    {
        // Return a virtual URL that Jellyfin's web server will serve via GetWebResourcePages
        return $"web/{name}";
    }

    /// <inheritdoc />
    public WebResourceInfo GetWebResource(string name)
    {
        if (name == "playback-indicator.js")
        {
            return new WebResourceInfo
            {
                Name = name,
                Type = "application/javascript"
            };
        }

        if (name == "branding.css")
        {
            return new WebResourceInfo
            {
                Name = name,
                Type = "text/css"
            };
        }

        return new WebResourceInfo { Name = name };
    }

    /// <inheritdoc />
    public IEnumerable<WebResourcePage> GetWebResourcePages()
    {
        return
        [
            new WebResourcePage
            {
                Name = "PlaybackIndicator",
                ResourceFileName = "playback-indicator.js",
                EmbeddedResourcePath = $"{GetType().Namespace}.Web.playback-indicator.js",
                Type = "application/javascript"
            },
            new WebResourcePage
            {
                Name = "PlaybackIndicatorCss",
                ResourceFileName = "branding.css",
                EmbeddedResourcePath = $"{GetType().Namespace}.Web.branding.css",
                Type = "text/css"
            }
        ];
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