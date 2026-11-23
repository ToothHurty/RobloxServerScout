(function () {
    // Parse the URL and compare the hostname instead of pattern-matching the
    // whole string. The old regex (/https:\/\/.+roblox.com/) also matched URLs
    // that merely contained "roblox.com" somewhere in a path or query string.
    const isRobloxSite = function (pageUrl) {
        if (!pageUrl) return false;

        try {
            const url = new URL(pageUrl);
            const host = url.hostname.toLowerCase();
            return url.protocol === 'https:' && (host === 'roblox.com' || host.endsWith('.roblox.com'));
        } catch (error) {
            return false;
        }
    };

    // The panel is injected on every Roblox page, not only on game pages: the
    // join-by-name box has to be reachable from the home page, a profile or the
    // catalog too. Only the sign-in pages are left alone, where a panel over the
    // form would just be in the way. Roblox also serves localised paths such as
    // /de/login.
    const isPanelPage = function (pageUrl) {
        if (!isRobloxSite(pageUrl)) return false;

        try {
            return !/^\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?(?:login|signup|logout)(?:\/|$)/i.test(new URL(pageUrl).pathname);
        } catch (error) {
            return false;
        }
    };

    // Runs in the page: reports whether the panel has already been injected.
    // The flag covers the window between start.js starting and the panel
    // actually landing in the DOM, where a second "complete" event used to
    // inject a duplicate panel.
    const checkPanelExists = function () {
        return Boolean(document.getElementById('ss-panel') || window.__ssInjected);
    };

    // Runs in the page's MAIN world, where Roblox's own launcher lives.
    // An empty instanceId means "the game, any server" - used when the player's
    // server id is hidden, where only the game itself can be joined.
    const launchGameSession = function (placeId, instanceId) {
        const launcher = window.Roblox && window.Roblox.GameLauncher;
        if (!launcher) return false;

        const place = Number(placeId);

        if (instanceId) {
            // Only a real instance join reaches the server the player is in;
            // joining the game at random would put the user somewhere else.
            if (typeof launcher.joinGameInstance !== 'function') return false;

            launcher.joinGameInstance(place, instanceId);
            return true;
        }

        if (typeof launcher.joinGame === 'function') {
            launcher.joinGame(place);
            return true;
        }

        // Roblox has moved this method around between web player versions, so
        // it is tried as the second choice rather than reported as missing.
        if (typeof launcher.joinMultiplayerGame === 'function') {
            launcher.joinMultiplayerGame(place);
            return true;
        }

        return false;
    };

    const injectPanel = async function (tabId) {
        const scriptTarget = { tabId };

        try {
            await chrome.scripting.insertCSS({
                target: scriptTarget,
                files: ['styles.css']
            });

            // start.js builds the panel; content.js waits for it before booting,
            // so the two can be injected back to back without a timing hack.
            await chrome.scripting.executeScript({
                target: scriptTarget,
                files: ['start.js']
            });

            await chrome.scripting.executeScript({
                target: scriptTarget,
                files: ['content.js']
            });
        } catch (error) {
            // Tab closed or navigated away mid-injection - nothing to recover.
            console.debug('ServerScout injection skipped:', error.message);
        }
    };

    const handleTabUpdate = async function (tabId, changeInfo, tab) {
        // A normal page load ends with status "complete". Roblox can also switch
        // pages without reloading - the address changes while the tab stays
        // complete - which never produced that event, so a URL change on an
        // already loaded tab counts too. Duplicates are ruled out below.
        const pageLoaded = changeInfo.status === 'complete';
        const inPageNavigation = Boolean(changeInfo.url) && Boolean(tab) && tab.status === 'complete';
        if (!pageLoaded && !inPageNavigation) return;

        if (!isPanelPage(changeInfo.url || (tab && tab.url))) return;

        let results;
        try {
            results = await chrome.scripting.executeScript({
                target: { tabId },
                func: checkPanelExists
            });
        } catch (error) {
            return;
        }

        const alreadyInjected = results && results[0] && results[0].result;
        if (alreadyInjected) return;

        await injectPanel(tabId);
    };

    const PLACE_ID_PATTERN = /^\d{1,20}$/;
    // Server (job) ids are GUIDs.
    const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const isValidJoinRequest = function (message) {
        if (!message || typeof message !== 'object') return false;

        const payload = message.message;
        if (!payload || typeof payload !== 'object') return false;

        // Both values end up as arguments of a call in the page's main world, so
        // anything that is not exactly a place id and a job id is refused. An
        // empty job id is allowed: that is a join to the game, any server.
        const serverId = String(payload.id);
        return PLACE_ID_PATTERN.test(String(payload.place)) &&
            (serverId === '' || JOB_ID_PATTERN.test(serverId));
    };

    const PRESENCE_ENDPOINT = 'https://presence.roblox.com/v1/presence/users';
    const MAX_PRESENCE_IDS = 100;

    const isPresenceRequest = function (message) {
        return Boolean(message && message.message && Array.isArray(message.message.userIds));
    };

    const isValidPresenceRequest = function (message) {
        const ids = message.message.userIds;
        return ids.length > 0 && ids.length <= MAX_PRESENCE_IDS &&
            ids.every(id => Number.isInteger(id) && id > 0);
    };

    // Answers the panel's presence lookup from here. Presence is the only thing
    // that knows which game and server a player is in, and it needs the Roblox
    // session: asked from the page it is a cross-site request whose cookies the
    // browser may withhold, which is why the join used to fail while the search
    // (which falls back to the avatar sweep) still worked. From the worker it is
    // a plain request with the extension's host permission and the session.
    const readPresence = async function (userIds) {
        const response = await fetch(PRESENCE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ userIds })
        });

        if (response.status === 401 || response.status === 403) {
            return { ok: false, authRequired: true, status: response.status };
        }

        if (!response.ok) {
            return { ok: false, error: `presence HTTP ${response.status}`, status: response.status };
        }

        return { ok: true, data: await response.json() };
    };

    const processRuntimeMessage = function (message, sender, sendResponse) {
        // Only accept messages from this extension's own scripts, and only ones
        // that actually look like something it sends.
        if (sender.id !== chrome.runtime.id) return false;
        if (!sender.tab || typeof sender.tab.id !== 'number') return false;
        // Neither a presence lookup nor a join by username depends on the page's
        // game, so both are valid on any Roblox page the panel runs on.
        if (!isRobloxSite(sender.tab.url)) return false;

        if (isPresenceRequest(message)) {
            if (!isValidPresenceRequest(message)) {
                sendResponse({ ok: false, error: 'invalid presence request' });
                return false;
            }

            readPresence(message.message.userIds)
                .then(sendResponse)
                .catch(error => sendResponse({ ok: false, error: error.message }));

            // Keeps the message channel open for the asynchronous response.
            return true;
        }

        if (!isValidJoinRequest(message)) {
            sendResponse({ ok: false, error: 'invalid join request' });
            return false;
        }

        chrome.scripting.executeScript({
            target: { tabId: sender.tab.id },
            func: launchGameSession,
            args: [String(message.message.place), String(message.message.id)],
            world: 'MAIN'
        }).then((results) => {
            // The panel used to get no answer at all, so a missing launcher
            // looked exactly like a join that silently did nothing.
            const launched = Boolean(results && results[0] && results[0].result);
            // `fallback` tells the panel it can still join through Roblox's
            // documented deep link when the in-page launcher has gone away.
            sendResponse(launched ? { ok: true } : { ok: false, fallback: true, error: 'Roblox launcher not available' });
        }).catch((error) => {
            console.debug('ServerScout join failed:', error.message);
            sendResponse({ ok: false, error: error.message });
        });

        // Keeps the message channel open for the asynchronous response.
        return true;
    };

    chrome.tabs.onUpdated.addListener(handleTabUpdate);
    chrome.runtime.onMessage.addListener(processRuntimeMessage);
})();
