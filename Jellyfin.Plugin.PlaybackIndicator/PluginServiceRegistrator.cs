using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.PlaybackIndicator;

/// <summary>
/// Registers the PlaybackIndicator API controller with Jellyfin's DI system.
/// </summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        // Controller is auto-discovered by Jellyfin via assembly scanning,
        // but we can register additional services here if needed.
    }
}
