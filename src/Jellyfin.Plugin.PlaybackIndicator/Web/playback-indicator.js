/**
 * Jellyfin Playback Indicator — Client-side badge injector
 *
 * Hooks into Jellyfin's SPA, detects series/movie pages,
 * and injects direct-play / transcode status badges on each item.
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

    function fetchPlaybackStatus(itemId) {
        var cached = getCached(itemId);
        if (cached) {
            log('Cache hit for %s: %s', itemId, cached.Status || cached.status);
            return Promise.resolve(cached);
        }

        var apiClient = getApiClient();
        if (!apiClient) {
            log('No ApiClient available, cannot fetch status');
            return Promise.resolve({ Status: 'Unknown', Reason: 'No ApiClient' });
        }

        var url = apiClient.getUrl('Plugin/PlaybackIndicator/PlaybackStatus/' + itemId);
        log('Fetching playback status: %s', url);

        return apiClient.getJSON(url).then(function (data) {
            log('Got status for %s: %O', itemId, data);
            setCache(itemId, data);
            return data;
        }).catch(function (err) {
            log('API error for %s: %O', itemId, err);
            return { Status: 'Unknown', Reason: String(err) };
        });
    }

    // ─── Badge rendering ────────────────────────────────────────────────────

    var badgeConfig = {
        'DirectPlay':     { icon: '\u2705', label: 'Direct Play',     cls: 'jpi-direct-play' },
        'DirectStream':   { icon: '\uD83D\uDCA7', label: 'Direct Stream',   cls: 'jpi-direct-stream' },
        'WillTranscode':  { icon: '\u26A0\uFE0F', label: 'Will Transcode',  cls: 'jpi-will-transcode' },
        'Transcoding':    { icon: '\uD83D\uDD04', label: 'Transcoding',     cls: 'jpi-transcoding' },
        'Unknown':        { icon: '\u2753', label: 'Unknown',         cls: 'jpi-unknown' }
    };

    // Inject theme-aware CSS once
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
            // Light theme overrides — Jellyfin adds .skin-light or similar
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
        // Remove existing badge if any
        var existing = el.querySelectorAll('.' + BADGE_CLASS);
        for (var i = 0; i < existing.length; i++) existing[i].remove();

        // For card items, inject into the card footer text area
        var nameEl = el.querySelector('.cardText, .listItemBodyText, .listItemBody, .cardFooter');
        if (nameEl) {
            nameEl.insertAdjacentHTML('afterend', ' ' + badgeHtml(status, reason));
            log('Badge injected after %s in %s', nameEl.className, el.className);
        } else {
            // Fallback: append to the element
            el.insertAdjacentHTML('beforeend', badgeHtml(status, reason));
            log('Badge injected (fallback) into %s', el.className);
        }
    }

    // ─── Row discovery ─────────────────────────────────────────────────────

    function findMediaItems() {
        var items = [];
        var seen = {};

        // Jellyfin 10.11 uses [data-id] on both .card and .listItem elements
        // data-type indicates the item type: Episode, Movie, Series, Season, etc.
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
        if (!CONFIG.showMovies) return;

        // Detect movie detail page by URL pattern and page structure
        var hash = window.location.hash || '';
        var href = window.location.href || '';
        var isDetailPage = hash.indexOf('details') !== -1 || hash.indexOf('item') !== -1
            || href.indexOf('/details') !== -1 || href.indexOf('id=') !== -1;

        if (!isDetailPage) return;

        // Find the detail page container — Jellyfin 10.11 uses various selectors
        var detailContainer = document.querySelector('.detailPageContent, .detailPagePrimaryContainer, .itemDetailPage');
        if (!detailContainer) return;

        // Don't re-inject if badge already exists on detail page
        if (detailContainer.querySelector('.' + BADGE_CLASS)) return;

        // Try to get the item ID from the URL
        var itemId = null;
        var idMatch = (hash + href).match(/[?&]id=([a-f0-9]+)/i);
        if (idMatch) {
            itemId = idMatch[1];
        }

        // Also try data-id on the detail container or nearby elements
        if (!itemId) {
            var detailEl = detailContainer.querySelector('[data-id]') || detailContainer.closest('[data-id]');
            if (detailEl) itemId = detailEl.getAttribute('data-id');
        }

        if (!itemId) {
            log('Detail page detected but no item ID found');
            return;
        }

        log('Detail page detected for item %s', itemId);

        // Find a good injection point — near the title or media info
        var injectTarget = detailContainer.querySelector('.infoWrapper, .detailPageWrapperContainer, .mainDetailInfo, .detailSectionHeader, .itemName, h1, h2, h3');
        if (!injectTarget) {
            injectTarget = detailContainer;
        }

        fetchPlaybackStatus(itemId).then(function (data) {
            // Check again in case it was injected while waiting
            if (detailContainer.querySelector('.' + BADGE_CLASS)) return;
            var html = badgeHtml(data.Status || data.status, data.Reason || data.reason, 'jpi-detail-badge');
            injectTarget.insertAdjacentHTML('afterend', html);
            log('Detail page badge injected for %s: %s', itemId, data.Status || data.status);
        });
    }

    // ─── Processing ────────────────────────────────────────────────────────

    var processing = false;
    var pendingProcess = false;

    function processVisibleItems() {
        // Always try the detail page badge (independent of card/list processing)
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
                injectBadge(el, data.Status || data.status, data.Reason || data.reason);
                // Stagger: 100ms between requests
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

        // Method 1: MutationObserver on the main app container
        // This is the most reliable way to detect new content in the SPA
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
                                (node.querySelector && node.querySelector('[data-id]'))) {
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

        // Watch the app body — Jellyfin renders everything inside .skinBody or body
        var watchTarget = document.querySelector('.skinBody') || document.body;
        observer.observe(watchTarget, { childList: true, subtree: true });
        log('MutationObserver watching: %s (class=%s)', watchTarget.tagName, watchTarget.className);

        // Method 2: Listen for viewshow event — Jellyfin fires this when a page view becomes active
        document.addEventListener('viewshow', function (e) {
            log('viewshow event fired: %O', e.target && e.target.className);
            setTimeout(processVisibleItems, 800);
        });

        // Method 3: hashchange for hash-based routing (#!/...)
        window.addEventListener('hashchange', function () {
            log('hashchange: %s', window.location.hash);
            setTimeout(processVisibleItems, 1000);
        });

        // Method 4: popstate for history-based routing
        window.addEventListener('popstate', function () {
            log('popstate: %s', window.location.href);
            setTimeout(processVisibleItems, 1000);
        });

        // Check current page immediately
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

        // Fetch server config to apply settings
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

    // Wait for ApiClient to be available
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(init, 1000);
        });
    } else {
        setTimeout(init, 1000);
    }

})();
