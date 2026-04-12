using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.PlaybackIndicator.Configuration;

public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// How many seconds to cache playback info per item (default: 1 hour).
    /// </summary>
    public int CacheTtlSeconds { get; set; } = 3600;

    /// <summary>
    /// Whether to show badges on movie library rows.
    /// </summary>
    public bool ShowOnMovies { get; set; } = true;

    /// <summary>
    /// Whether to show badges on TV episode rows.
    /// </summary>
    public bool ShowOnTvShows { get; set; } = true;
}
