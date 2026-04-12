using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.PlaybackIndicator;

/// <summary>
/// Registers plugin services in the DI container.
/// </summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        // Detection is now done client-side via Jellyfin's built-in PlaybackInfo API.
        // No server-side services needed beyond the controller.
    }
}
