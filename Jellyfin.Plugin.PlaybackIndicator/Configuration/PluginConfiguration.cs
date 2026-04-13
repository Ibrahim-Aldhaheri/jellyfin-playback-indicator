using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.PlaybackIndicator.Configuration;

/// <summary>
/// Plugin configuration options.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PluginConfiguration"/> class.
    /// </summary>
    public PluginConfiguration()
    {
        CacheTtlMinutes = 60;
        ShowBadgeOnMovies = true;
        ShowBadgeOnEpisodes = true;
    }

    /// <summary>
    /// Gets or sets the cache TTL in minutes for playback info lookups.
    /// </summary>
    public int CacheTtlMinutes { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether badges are shown on movie rows.
    /// </summary>
    public bool ShowBadgeOnMovies { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether badges are shown on episode rows.
    /// </summary>
    public bool ShowBadgeOnEpisodes { get; set; }
}