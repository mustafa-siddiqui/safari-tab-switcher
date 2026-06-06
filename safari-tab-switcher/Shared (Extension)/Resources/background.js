let tabAccessOrder = [];

// Track tab activation to maintain MRU (Most Recently Used) list
browser.tabs.onActivated.addListener((activeInfo) => {
    updateTabAccessOrder(activeInfo.tabId);
});

browser.tabs.onRemoved.addListener((tabId) => {
    const index = tabAccessOrder.indexOf(tabId);
    if (index > -1) {
        tabAccessOrder.splice(index, 1);
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
}

// Listen for keyboard command (Ctrl+K)
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
