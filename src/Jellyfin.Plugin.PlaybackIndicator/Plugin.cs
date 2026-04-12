using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.PlaybackIndicator.Configuration;
using Jellyfin.Plugin.PlaybackIndicator.Services;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.PlaybackIndicator;

/// <summary>
/// Main plugin class — exposes a configuration page and serves the playback indicator JS.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public const string PluginGuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

    private readonly PlaybackIndicatorStartupService _startupService;
    private readonly ILogger<Plugin> _logger;

    public Plugin(
        IApplicationPaths applicationPaths,
        IXmlSerializer xmlSerializer,
        ILogger<Plugin> logger,
        ILogger<PlaybackIndicatorStartupService> startupServiceLogger)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        _logger = logger;

        _logger.LogInformation("Playback Indicator plugin loading...");

        if (Configuration.EnableDebugLogging)
        {
            _logger.LogDebug("Debug logging is enabled. Config: CacheTtl={CacheTtl}, ShowOnMovies={ShowOnMovies}, ShowOnTvShows={ShowOnTvShows}",
                Configuration.CacheTtlSeconds, Configuration.ShowOnMovies, Configuration.ShowOnTvShows);
        }

        _startupService = new PlaybackIndicatorStartupService(applicationPaths, startupServiceLogger);

        // Inject JS into index.html on plugin load (once per server restart)
        _startupService.InjectJsLoaderAsync().GetAwaiter().GetResult();

        _logger.LogInformation("Playback Indicator plugin loaded successfully.");
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
