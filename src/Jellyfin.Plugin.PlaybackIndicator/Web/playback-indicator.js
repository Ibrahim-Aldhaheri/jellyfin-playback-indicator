/**
 * Jellyfin Playback Indicator — Client-side badge injector
 *
 * Hooks into Jellyfin's SPA router, detects series/movie pages,
 * and injects direct-play / transcode status badges on each row.
 *
 * Badge states:
 *   ✅ Direct Play  — green  — container + video + audio all compatible
 *   ⚠️ Will Transcode — amber — codec/container/bitrate requires transcoding
 *   🔄 Transcoding  — red   — currently being transcoded (during playback)
 *   ❓ Unknown      — grey   — could not determine status
 */

(function () {
    'use strict';

    const CONFIG = window.PlaybackIndicatorConfig || {
        cacheTtl: 3600,
        showTv: true,
        showMovies: true,
        apiBase: window.ApiClient ? ApiClient.serverAddress() : ''
    };

    const BADGE_CLASS = 'jpi-badge';
    const CACHE_PREFIX = 'jpi_cache_';

    // ─── Logging ────────────────────────────────────────────────────────────

    function log(msg, ...args) {
        console.debug('[PlaybackIndicator]', msg, ...args);
    }

    // ─── Cache ─────────────────────────────────────────────────────────────

    function getCached(itemId) {
        try {
            const raw = localStorage.getItem(CACHE_PREFIX + itemId);
            if (!raw) return null;
            const { data, expiry } = JSON.parse(raw);
            if (Date.now() > expiry) {
                localStorage.removeItem(CACHE_PREFIX + itemId);
                return null;
            }
            return data;
        } catch {
            return null;
        }
    }

    function setCache(itemId, data) {
        try {
            localStorage.setItem(CACHE_PREFIX + itemId, JSON.stringify({
                data,
                expiry: Date.now() + CONFIG.cacheTtl * 1000
            }));
        } catch {}
    }

    // ─── API ────────────────────────────────────────────────────────────────

    function fetchPlaybackStatus(itemId) {
        const cached = getCached(itemId);
        if (cached) {
            log('Cache hit for', itemId, cached.status);
            return Promise.resolve(cached);
        }

        const url = `${CONFIG.apiBase}/Plugin/PlaybackIndicator/PlaybackStatus/${itemId}`;
        return fetch(url, { credentials: 'include' })
            .then(r => r.json())
            .then(data => {
                setCache(itemId, data);
                return data;
            })
            .catch(err => {
                log('API error for', itemId, err);
                return { status: 'unknown', reason: err.message };
            });
    }

    // ─── Badge rendering ────────────────────────────────────────────────────

    function badgeHtml(status, reason) {
        const icons = {
            'direct_play':    '✅',
            'direct_stream':  '💧',
            'will_transcode': '⚠️',
            'transcoding':    '🔄',
            'unknown':        '❓'
        };
        const labels = {
            'direct_play':    'Direct Play',
            'direct_stream':  'Direct Stream',
            'will_transcode': 'Will Transcode',
            'transcoding':    'Transcoding',
            'unknown':        'Unknown'
        };
        const css = {
            'direct_play':    'background:#e8f5e9;color:#2e7d32',
            'direct_stream':  'background:#e3f2fd;color:#1565c0',
            'will_transcode': 'background:#fff3e0;color:#e65100',
            'transcoding':    'background:#ffebee;color:#c62828',
            'unknown':        'background:#f5f5f5;color:#757575'
        };

        const key = status || 'unknown';
        const icon = icons[key] || '❓';
        const label = labels[key] || 'Unknown';
        const style = css[key] || css.unknown;

        return `<span class="${BADGE_CLASS}" style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;${style}" title="${reason || label}">${icon} ${label}</span>`;
    }

    function injectBadge(el, status, reason) {
        // Remove existing badge if any
        el.querySelectorAll('.' + BADGE_CLASS).forEach(b => b.remove());

        // Find a good insertion point — after the title/name element
        const nameEl = el.querySelector('.name, .title, [data-role="button"]:not([data-action]), .flex-grow-1');
        if (nameEl) {
            nameEl.insertAdjacentHTML('beforeend', ' ' + badgeHtml(status, reason));
        } else {
            // Fallback: prepend to the list item
            el.insertAdjacentHTML('afterbegin', badgeHtml(status, reason));
        }
    }

    // ─── Row discovery ─────────────────────────────────────────────────────

    /**
     * Find all episode/movie rows on the current page.
     * Jellyfin renders these as:
     *   - Episodes:  paper-listbox items with data-episode-id
     *   - Movies:    card overlays with data-id
     */
    function findMediaRows() {
        const rows = [];

        if (CONFIG.showTv) {
            // Episode list items in a season page
            document.querySelectorAll('[data-episode-id], .episodeItem, paper-listbox .item').forEach(el => {
                if (!el.querySelector('.' + BADGE_CLASS)) rows.push(el);
            });
        }

        if (CONFIG.showMovies) {
            // Movie cards in library view
            document.querySelectorAll('.card, [data-id][data-type="Movie"], .libraryGrid .item').forEach(el => {
                if (!el.querySelector('.' + BADGE_CLASS)) rows.push(el);
            });
        }

        return rows;
    }

    /**
     * Extract the media item ID from a row element.
     */
    function getItemId(row) {
        return row.dataset.episodeId
            || row.dataset.id
            || row.getAttribute('data-id')
            || null;
    }

    // ─── Processing ────────────────────────────────────────────────────────

    let processing = false;

    async function processVisibleRows() {
        if (processing) return;
        processing = true;

        const rows = findMediaRows();
        if (rows.length === 0) {
            processing = false;
            return;
        }

        log(`Processing ${rows.length} rows...`);

        // Stagger requests to avoid hammering the API
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const itemId = getItemId(row);

            if (!itemId) continue;

            try {
                const status = await fetchPlaybackStatus(itemId);
                injectBadge(row, status.status, status.reason);
            } catch (e) {
                log('Error processing row', itemId, e);
            }

            // Stagger: 100ms between requests
            if (i < rows.length - 1) {
                await new Promise(r => setTimeout(r, 100));
            }
        }

        processing = false;
    }

    // ─── SPA Router hook ───────────────────────────────────────────────────

    /**
     * Jellyfin's web client uses a viewstack to manage page navigation.
     * We hook into the 'viewstack' event or MutationObserver on the main content area.
     */
    function initRouterHook() {
        // Method 1: Listen for Jellyfin's global 'viewstackchange' event
        window.addEventListener('viewstackchange', (e) => {
            const stack = e.detail?.stack || [];
            const current = stack[stack.length - 1];
            log('View stack changed:', current);
            if (isMediaPage(current?.type)) {
                // Page load — wait for DOM to render
                setTimeout(processVisibleRows, 800);
            }
        });

        // Method 2: MutationObserver as fallback — watches for new rows added to DOM
        const observer = new MutationObserver((mutations) => {
            let shouldProcess = false;
            for (const m of mutations) {
                if (m.addedNodes.length > 0) {
                    for (const node of m.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.matches?.('[data-episode-id], .episodeItem, .card')) {
                                shouldProcess = true;
                                break;
                            }
                            if (node.querySelector?.('[data-episode-id], .episodeItem, .card')) {
                                shouldProcess = true;
                                break;
                            }
                        }
                    }
                }
                if (shouldProcess) break;
            }
            if (shouldProcess) {
                setTimeout(processVisibleRows, 400);
            }
        });

        // Watch the main content area
        const content = document.querySelector('#indexElement, #pageWithContainer, main, .mainDetailPage, .skinBody');
        if (content) {
            observer.observe(content, { childList: true, subtree: true });
            log('MutationObserver watching:', content.tagName, content.className);
        }

        // Method 3: Listen for route changes via Jellyfin's app router
        document.addEventListener('routechange', (e) => {
            log('Route changed:', e.detail);
            if (isMediaPage(e.detail?.route?.name)) {
                setTimeout(processVisibleRows, 800);
            }
        });

        // Also check current page on initial load
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', checkCurrentPage);
        } else {
            checkCurrentPage();
        }
    }

    function isMediaPage(pageType) {
        if (!pageType) return false;
        const mediaTypes = [
            'season', 'episodes', 'tvshows', 'tvshow',
            'movies', 'movie', 'library', 'libraries',
            'seasonplay', 'episodedetails'
        ];
        return mediaTypes.includes(pageType.toLowerCase());
    }

    function checkCurrentPage() {
        const url = window.location.href;
        log('Current URL:', url);

        // Jellyfin URLs for series/movies:
        // /web/#!/season?id=<itemId>
        // /web/#!/movies?id=<itemId>
        // /web/#!/tvshows/details?id=<itemId>
        if (/\/season\b|\/episodes\b|\/tvshows\b|\/movies\b|\/libraries\b/.test(url)) {
            log('Detected media page on load');
            setTimeout(processVisibleRows, 1000);
        }
    }

    // ─── Init ──────────────────────────────────────────────────────────────

    function init() {
        log('PlaybackIndicator JS loaded', CONFIG);
        initRouterHook();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
