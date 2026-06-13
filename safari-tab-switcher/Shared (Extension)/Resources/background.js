let tabAccessOrder = [];
let saveTimeout = null;

// Load state from storage on startup
async function loadState() {
    try {
        const data = await browser.storage.local.get('tabAccessOrder');
        if (data.tabAccessOrder) {
            tabAccessOrder = data.tabAccessOrder;
        }
        
        // Reconcile with actual open tabs (Safari can kill the worker)
        const allTabs = await browser.tabs.query({});
        const currentTabIds = new Set(allTabs.map(t => t.id));
        
        // Remove tabs that no longer exist
        tabAccessOrder = tabAccessOrder.filter(id => currentTabIds.has(id));
        
        // Add existing tabs that aren't in our list yet (e.g. opened while extension was inactive)
        for (const tabId of currentTabIds) {
            if (!tabAccessOrder.includes(tabId)) {
                tabAccessOrder.push(tabId);
            }
        }
    } catch (e) {
        console.error("Error loading state:", e);
    }
}

// Debounced save to minimize disk writes
function debouncedSave() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
        try {
            await browser.storage.local.set({ tabAccessOrder });
        } catch (e) {
            console.error("Error saving state:", e);
        }
    }, 2000); // 2 second debounce
}

// Initialize
loadState();

// Track tab activation to maintain MRU (Most Recently Used) list
browser.tabs.onActivated.addListener((activeInfo) => {
    updateTabAccessOrder(activeInfo.tabId);
});

browser.tabs.onRemoved.addListener((tabId) => {
    const index = tabAccessOrder.indexOf(tabId);
    if (index > -1) {
        tabAccessOrder.splice(index, 1);
        debouncedSave();
    }
});

function updateTabAccessOrder(tabId) {
    const index = tabAccessOrder.indexOf(tabId);
    if (index > -1) {
        tabAccessOrder.splice(index, 1);
    }
    tabAccessOrder.unshift(tabId);
    // Keep reasonable limit
    tabAccessOrder = tabAccessOrder.slice(0, 50);
    debouncedSave();
}

// Listen for keyboard command (Ctrl+E)
browser.commands.onCommand.addListener(async (command) => {
    if (command === 'toggle-switcher') {
        await handleToggleSwitcher();
    }
});

async function handleToggleSwitcher() {
    try {
        const currentWindow = await browser.windows.getCurrent();
        const allTabs = await browser.tabs.query({ windowId: currentWindow.id });
        
        // Map tabs and sort them
        const tabs = allTabs.map(tab => ({
            id: tab.id,
            title: tab.title || 'Loading...',
            url: tab.url || '',
            active: tab.active,
            windowId: tab.windowId,
            favicon: tab.favIconUrl || ''
        }));

        const tabMap = new Map(tabs.map(tab => [tab.id, tab]));
        const sortedTabs = [];

        // Add tabs in order of recent usage
        for (const tabId of tabAccessOrder) {
            if (tabMap.has(tabId)) {
                sortedTabs.push(tabMap.get(tabId));
                tabMap.delete(tabId);
            }
        }

        // Add remaining tabs
        for (const tab of tabMap.values()) {
            sortedTabs.push(tab);
        }

        // Send tabs to the native handler to display the overlay. The native
        // handler keeps THIS request open until the user picks a tab in the
        // macOS app, then resolves it with the chosen WebExtension tab id.
        // We must do the actual switch here, because only background.js knows
        // the real browser.tabs ids (matching by URL would break on duplicates).
        const response = await browser.runtime.sendNativeMessage("application.id", {
            action: "showSwitcher",
            tabs: sortedTabs
        });

        const selectedTabId = response && response.selectedTabId;
        if (typeof selectedTabId === "number" && selectedTabId >= 0) {
            await browser.tabs.update(selectedTabId, { active: true });
            const selected = sortedTabs.find(t => t.id === selectedTabId);
            if (selected && selected.windowId != null) {
                await browser.windows.update(selected.windowId, { focused: true });
            }
        }

    } catch (error) {
        console.error("Error toggling switcher:", error);
    }
}
