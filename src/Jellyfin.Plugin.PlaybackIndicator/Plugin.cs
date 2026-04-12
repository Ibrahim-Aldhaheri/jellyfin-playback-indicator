using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.PlaybackIndicator.Configuration;
using Jellyfin.Plugin.PlaybackIndicator.Services;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.PlaybackIndicator;

/// <summary>
/// Main plugin class — exposes a configuration page and serves the playback indicator JS.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public const string PluginGuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

    private readonly PlaybackIndicatorStartupService _startupService;

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        _startupService = new PlaybackIndicatorStartupService(applicationPaths);
        // Inject JS into index.html on plugin load (once per server restart)
        _startupService.InjectJsLoaderAsync().GetAwaiter().GetResult();
    }

    public override string Name => "Playback Indicator";

    public override Guid Id => Guid.Parse(PluginGuid);

    public static Plugin? Instance { get; private set; }

    /// <summary>
    /// Updates and persists the plugin configuration.
    /// </summary>
    public void UpdateConfiguration(PluginConfiguration config)
    {
        Configuration = config;
        SaveConfiguration();
    }

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        return
        [
            new PluginPageInfo
            {
                Name = Name,
                EmbeddedResourcePath = string.Format(
                    CultureInfo.InvariantCulture,
                    "{0}.Web.configPage.html",
                    GetType().Namespace)
            }
        ];
    }
}
