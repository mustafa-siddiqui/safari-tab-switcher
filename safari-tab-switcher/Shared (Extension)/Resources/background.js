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

        // Send to native Swift handler to display the UI
        const response = await browser.runtime.sendNativeMessage("application.id", {
            action: "showSwitcher",
            tabs: sortedTabs
        });
        
        console.log("Native response:", response);

    } catch (error) {
        console.error("Error toggling switcher:", error);
    }
}

// Listen for messages FROM the native Swift code (e.g., to actually perform the switch)
// Note: SFSafariApplication.dispatchMessage uses browser.runtime.onMessage
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "switchToTab" && request.tabId) {
        browser.tabs.update(request.tabId, { active: true });
        if (request.windowId) {
             browser.windows.update(request.windowId, { focused: true });
        }
        sendResponse({ success: true });
    }
});
