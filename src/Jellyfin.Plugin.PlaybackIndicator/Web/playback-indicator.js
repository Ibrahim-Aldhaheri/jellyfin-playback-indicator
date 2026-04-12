/**
 * Jellyfin Playback Indicator — Client-side badge injector
 *
 * Hooks into Jellyfin's SPA, detects series/movie pages,
 * and injects direct-play / transcode status badges on each item.
 *
 * Detection uses Jellyfin's built-in PlaybackInfo API which returns
 * the exact play method for the current client/device automatically.
 */

(function () {
    'use strict';

    var CONFIG = {
        cacheTtl: 3600,
        showTv: true,
        showMovies: true,
        debugLogging: true
    };

    var BADGE_CLASS = 'jpi-badge';
    var CACHE_PREFIX = 'jpi_cache_';

    // ─── Logging ────────────────────────────────────────────────────────────

    function log(msg) {
        if (!CONFIG.debugLogging) return;
        var args = Array.prototype.slice.call(arguments);
        args[0] = '[PlaybackIndicator] ' + args[0];
        console.debug.apply(console, args);
    }

    // ─── Cache ─────────────────────────────────────────────────────────────

    function getCached(itemId) {
        try {
            var raw = localStorage.getItem(CACHE_PREFIX + itemId);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            if (Date.now() > parsed.expiry) {
                localStorage.removeItem(CACHE_PREFIX + itemId);
                return null;
            }
            return parsed.data;
        } catch (e) {
            return null;
        }
    }

    function setCache(itemId, data) {
        try {
            localStorage.setItem(CACHE_PREFIX + itemId, JSON.stringify({
                data: data,
                expiry: Date.now() + CONFIG.cacheTtl * 1000
            }));
        } catch (e) {}
    }

    // ─── API ────────────────────────────────────────────────────────────────

    function getApiClient() {
        return window.ApiClient || (window.Emby && window.Emby.ApiClient) || null;
    }

    /**
     * Calls Jellyfin's built-in PlaybackInfo API to determine the exact
     * play method (DirectPlay / DirectStream / Transcode) for this client.
     * This is the same API Jellyfin's own web player uses — it automatically
     * uses the correct device profile for whatever client is making the request.
     */
    function fetchPlaybackStatus(itemId) {
        var cached = getCached(itemId);
        if (cached) {
            log('Cache hit for %s: %s', itemId, cached.Status);
            return Promise.resolve(cached);
        }

        var apiClient = getApiClient();
        if (!apiClient) {
            log('No ApiClient available, cannot fetch status');
            return Promise.resolve({ Status: 'Unknown', Reason: 'No ApiClient' });
        }

        var userId = apiClient.getCurrentUserId();
        var url = apiClient.getUrl('Items/' + itemId + '/PlaybackInfo', { userId: userId });
        log('Fetching PlaybackInfo: %s', url);

        return apiClient.getJSON(url).then(function (playbackInfo) {
            log('PlaybackInfo for %s: %O', itemId, playbackInfo);

            var result = parsePlaybackInfo(playbackInfo);
            result.ItemId = itemId;

            log('Determined status for %s: %s (%s)', itemId, result.Status, result.Reason);
            setCache(itemId, result);
            return result;
        }).catch(function (err) {
            log('PlaybackInfo API error for %s: %O', itemId, err);
            return { Status: 'Unknown', Reason: String(err) };
        });
    }

    /**
     * Parses Jellyfin's PlaybackInfoResponse to determine play method.
     *
     * MediaSources[0]:
     *   - SupportsDirectPlay = true  → DirectPlay
     *   - SupportsDirectStream = true → DirectStream (remux, no re-encode)
     *   - TranscodingUrl exists      → Transcode
     */
    function parsePlaybackInfo(info) {
        if (!info || !info.MediaSources || info.MediaSources.length === 0) {
            return { Status: 'Unknown', Reason: 'No media sources' };
        }

        var source = info.MediaSources[0];

        if (source.SupportsDirectPlay) {
            return { Status: 'DirectPlay', Reason: 'Direct Play — no conversion needed' };
        }

        if (source.SupportsDirectStream) {
            return { Status: 'DirectStream', Reason: 'Direct Stream — container remux, no re-encoding' };
        }

        if (source.TranscodingUrl) {
            var reason = 'Transcode required';
            if (source.TranscodingSubProtocol) {
                reason += ' (' + source.TranscodingSubProtocol + ')';
            }
            return { Status: 'WillTranscode', Reason: reason };
        }

        return { Status: 'Unknown', Reason: 'Could not determine play method' };
    }

    // ─── Badge rendering ────────────────────────────────────────────────────

    var badgeConfig = {
        'DirectPlay':     { icon: '\u2705', label: 'Direct Play',     cls: 'jpi-direct-play' },
        'DirectStream':   { icon: '\uD83D\uDCA7', label: 'Direct Stream',   cls: 'jpi-direct-stream' },
        'WillTranscode':  { icon: '\u26A0\uFE0F', label: 'Will Transcode',  cls: 'jpi-will-transcode' },
        'Transcoding':    { icon: '\uD83D\uDD04', label: 'Transcoding',     cls: 'jpi-transcoding' },
        'Unknown':        { icon: '\u2753', label: 'Unknown',         cls: 'jpi-unknown' }
    };

    function injectStyles() {
        if (document.getElementById('jpi-styles')) return;
        var style = document.createElement('style');
        style.id = 'jpi-styles';
        style.textContent = [
            '.jpi-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap;line-height:1.4;vertical-align:middle}',
            '.jpi-direct-play{background:rgba(46,125,50,0.15);color:#4caf50}',
            '.jpi-direct-stream{background:rgba(21,101,192,0.15);color:#42a5f5}',
            '.jpi-will-transcode{background:rgba(230,81,0,0.15);color:#ff9800}',
            '.jpi-transcoding{background:rgba(198,40,40,0.15);color:#ef5350}',
            '.jpi-unknown{background:rgba(117,117,117,0.15);color:#9e9e9e}',
            '@media(prefers-color-scheme:light){',
            '  .jpi-direct-play{background:rgba(46,125,50,0.12);color:#2e7d32}',
            '  .jpi-direct-stream{background:rgba(21,101,192,0.12);color:#1565c0}',
            '  .jpi-will-transcode{background:rgba(230,81,0,0.12);color:#e65100}',
            '  .jpi-transcoding{background:rgba(198,40,40,0.12);color:#c62828}',
            '  .jpi-unknown{background:rgba(117,117,117,0.1);color:#757575}',
            '}',
            '.jpi-detail-badge{margin:8px 0;display:block}'
        ].join('\n');
        document.head.appendChild(style);
    }

    function badgeHtml(status, reason, extraClass) {
        var key = status || 'Unknown';
        var cfg = badgeConfig[key] || badgeConfig['Unknown'];
        var cls = BADGE_CLASS + ' ' + cfg.cls + (extraClass ? ' ' + extraClass : '');

        return '<span class="' + cls + '" title="' + (reason || cfg.label).replace(/"/g, '&quot;') + '">' + cfg.icon + ' ' + cfg.label + '</span>';
    }

    function injectBadge(el, status, reason) {
        var existing = el.querySelectorAll('.' + BADGE_CLASS);
        for (var i = 0; i < existing.length; i++) existing[i].remove();

        var nameEl = el.querySelector('.cardText, .listItemBodyText, .listItemBody, .cardFooter');
        if (nameEl) {
            nameEl.insertAdjacentHTML('afterend', ' ' + badgeHtml(status, reason));
            log('Badge injected after %s in %s', nameEl.className, el.className);
        } else {
            el.insertAdjacentHTML('beforeend', badgeHtml(status, reason));
            log('Badge injected (fallback) into %s', el.className);
        }
    }

    // ─── Row discovery ─────────────────────────────────────────────────────

    function findMediaItems() {
        var items = [];
        var seen = {};

        var selectors = [];

        if (CONFIG.showTv) {
            selectors.push('.listItem[data-id][data-type="Episode"]');
            selectors.push('.card[data-id][data-type="Episode"]');
        }

        if (CONFIG.showMovies) {
            selectors.push('.listItem[data-id][data-type="Movie"]');
            selectors.push('.card[data-id][data-type="Movie"]');
        }

        if (selectors.length === 0) return items;

        var allSelector = selectors.join(', ');
        var elements = document.querySelectorAll(allSelector);

        log('findMediaItems: selector "%s" matched %d elements', allSelector, elements.length);

        for (var i = 0; i < elements.length; i++) {
            var el = elements[i];
            var id = el.getAttribute('data-id');
            if (!id || seen[id]) continue;
            if (el.querySelector('.' + BADGE_CLASS)) continue;
            seen[id] = true;
            items.push(el);
        }

        log('findMediaItems: %d unique items without badges', items.length);
        return items;
    }

    // ─── Detail page badge ───────────────────────────────────────────────

    function tryInjectDetailPageBadge() {
        var hash = window.location.hash || '';
        var href = window.location.href || '';
        var fullUrl = hash + ' ' + href;
        var isDetailPage = /[#/](details|item)\b/.test(fullUrl) || /[?&]id=/.test(fullUrl);

        if (!isDetailPage) {
            log('Not a detail page: %s', hash || href);
            return;
        }

        var itemId = null;
        var idMatch = fullUrl.match(/[?&]id=([a-f0-9-]+)/i);
        if (idMatch) {
            itemId = idMatch[1];
        }

        if (!itemId) {
            log('Detail page detected but no item ID found in URL');
            return;
        }

        var isMovie = /type=Movie/i.test(fullUrl);
        var isEpisode = /type=Episode/i.test(fullUrl);

        if (!isMovie && !isEpisode) {
            if (!CONFIG.showMovies && !CONFIG.showTv) return;
        } else {
            if (isMovie && !CONFIG.showMovies) return;
            if (isEpisode && !CONFIG.showTv) return;
        }

        log('Detail page detected for item %s', itemId);

        // Jellyfin 10.11 detail page DOM structure:
        // #itemDetailPage > .detailPageWrapperContainer > .detailPagePrimaryContainer
        //   > .detailRibbon > .infoWrapper > .itemMiscInfo-primary / .itemMiscInfo-secondary
        var detailPage = document.getElementById('itemDetailPage');
        if (!detailPage) {
            detailPage = document.querySelector('.itemDetailPage');
        }

        if (!detailPage) {
            log('Detail page container #itemDetailPage not found');
            return;
        }

        if (detailPage.querySelector('.' + BADGE_CLASS)) return;

        // Inject after the primary or secondary misc info line in the ribbon
        var injectTarget =
            detailPage.querySelector('.itemMiscInfo-primary') ||
            detailPage.querySelector('.itemMiscInfo-secondary') ||
            detailPage.querySelector('.itemMiscInfo') ||
            detailPage.querySelector('.infoWrapper') ||
            detailPage.querySelector('.nameContainer');

        if (!injectTarget) {
            log('No suitable injection target found on detail page');
            return;
        }

        log('Detail badge injection target: %s', injectTarget.className);

        fetchPlaybackStatus(itemId).then(function (data) {
            if (detailPage.querySelector('.' + BADGE_CLASS)) return;
            var html = badgeHtml(data.Status, data.Reason, 'jpi-detail-badge');
            injectTarget.insertAdjacentHTML('afterend', html);
            log('Detail page badge injected for %s: %s', itemId, data.Status);
        });
    }

    // ─── Processing ────────────────────────────────────────────────────────

    var processing = false;
    var pendingProcess = false;

    function processVisibleItems() {
        tryInjectDetailPageBadge();

        if (processing) {
            pendingProcess = true;
            return;
        }
        processing = true;

        var items = findMediaItems();
        if (items.length === 0) {
            processing = false;
            return;
        }

        log('Processing %d items...', items.length);

        var idx = 0;
        function processNext() {
            if (idx >= items.length) {
                processing = false;
                if (pendingProcess) {
                    pendingProcess = false;
                    setTimeout(processVisibleItems, 500);
                }
                return;
            }

            var el = items[idx];
            var itemId = el.getAttribute('data-id');
            idx++;

            if (!itemId) {
                processNext();
                return;
            }

            fetchPlaybackStatus(itemId).then(function (data) {
                injectBadge(el, data.Status, data.Reason);
                setTimeout(processNext, 100);
            }).catch(function (e) {
                log('Error processing item %s: %O', itemId, e);
                setTimeout(processNext, 100);
            });
        }

        processNext();
    }

    // ─── SPA Router hook ───────────────────────────────────────────────────

    function initRouterHook() {
        log('Initializing router hooks...');

        var debounceTimer = null;
        var observer = new MutationObserver(function (mutations) {
            var dominated = false;
            for (var i = 0; i < mutations.length; i++) {
                var m = mutations[i];
                if (m.addedNodes.length > 0) {
                    for (var j = 0; j < m.addedNodes.length; j++) {
                        var node = m.addedNodes[j];
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if ((node.getAttribute && node.getAttribute('data-id')) ||
                                (node.querySelector && node.querySelector('[data-id]')) ||
                                (node.id === 'itemDetailPage') ||
                                (node.classList && node.classList.contains('itemDetailPage')) ||
                                (node.querySelector && node.querySelector('#itemDetailPage, .itemMiscInfo'))) {
                                dominated = true;
                                break;
                            }
                        }
                    }
                }
                if (dominated) break;
            }
            if (dominated) {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(processVisibleItems, 600);
            }
        });

        var watchTarget = document.querySelector('.skinBody') || document.body;
        observer.observe(watchTarget, { childList: true, subtree: true });
        log('MutationObserver watching: %s (class=%s)', watchTarget.tagName, watchTarget.className);

        document.addEventListener('viewshow', function (e) {
            log('viewshow event fired: %O', e.target && e.target.className);
            setTimeout(processVisibleItems, 800);
        });

        window.addEventListener('hashchange', function () {
            log('hashchange: %s', window.location.hash);
            setTimeout(processVisibleItems, 1000);
        });

        window.addEventListener('popstate', function () {
            log('popstate: %s', window.location.href);
            setTimeout(processVisibleItems, 1000);
        });

        log('Checking current page on init...');
        setTimeout(processVisibleItems, 1500);
    }

    // ─── Init ──────────────────────────────────────────────────────────────

    function init() {
        log('Playback Indicator JS loading...');

        var apiClient = getApiClient();
        if (!apiClient) {
            log('ApiClient not available yet, retrying in 2s...');
            setTimeout(init, 2000);
            return;
        }

        var settingsUrl = apiClient.getUrl('Plugin/PlaybackIndicator/Settings');
        log('Fetching settings from: %s', settingsUrl);

        apiClient.getJSON(settingsUrl).then(function (cfg) {
            if (!cfg) {
                log('Settings response empty, plugin may be misconfigured');
                return;
            }

            log('Settings loaded: %O', cfg);

            CONFIG.debugLogging = cfg.EnableDebugLogging !== false;
            if (cfg.CacheTtlSeconds) CONFIG.cacheTtl = cfg.CacheTtlSeconds;
            if (cfg.ShowOnTvShows !== undefined) CONFIG.showTv = cfg.ShowOnTvShows;
            if (cfg.ShowOnMovies !== undefined) CONFIG.showMovies = cfg.ShowOnMovies;

            log('Config applied: debug=%s, cacheTtl=%d, showTv=%s, showMovies=%s',
                CONFIG.debugLogging, CONFIG.cacheTtl, CONFIG.showTv, CONFIG.showMovies);

            injectStyles();
            initRouterHook();
        }).catch(function (err) {
            log('Failed to load settings (plugin may be uninstalled): %O', err);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(init, 1000);
        });
    } else {
        setTimeout(init, 1000);
    }

})();
