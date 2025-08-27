let tabSwitcher = {
    tabs: [],
    tabAccessOrder: [], // Track recently used tabs

    init() {
        // Listen for messages from content scripts
        browser.runtime.onMessage.addListener(this.handleMessage.bind(this));

        // Track tab access for recent ordering
        browser.tabs.onActivated.addListener((activeInfo) => {
            this.updateTabAccessOrder(activeInfo.tabId);
            this.updateTabList();
        });

        browser.tabs.onUpdated.addListener(() => this.updateTabList());
        browser.tabs.onCreated.addListener(() => this.updateTabList());
        browser.tabs.onRemoved.addListener((tabId) => {
            this.removeFromAccessOrder(tabId);
            this.updateTabList();
        });

        this.updateTabList();
    },

    updateTabAccessOrder(tabId) {
        // Remove tab from current position if it exists
        const index = this.tabAccessOrder.indexOf(tabId);
        if (index > -1) {
            this.tabAccessOrder.splice(index, 1);
        }
        // Add to front (most recent)
        this.tabAccessOrder.unshift(tabId);

        // Keep only last 50 tabs in history to avoid memory bloat
        this.tabAccessOrder = this.tabAccessOrder.slice(0, 50);
    },

    removeFromAccessOrder(tabId) {
        const index = this.tabAccessOrder.indexOf(tabId);
        if (index > -1) {
            this.tabAccessOrder.splice(index, 1);
        }
    },

    async handleMessage(message, sender, sendResponse) {
        switch (message.action) {
            case 'getTabList':
                await this.updateTabList();
                return { tabs: this.tabs };

            case 'switchToTab':
                await this.switchToTab(message.tabId);
                break;

            case 'toggleSwitcher':
                await this.toggleSwitcher(sender.tab);
                break;
        }
    },

    async updateTabList() {
        try {
            const allTabs = await browser.tabs.query({});
            this.tabs = allTabs.map(tab => ({
                id: tab.id,
                title: tab.title || 'Loading...',
                url: tab.url || '',
                active: tab.active,
                windowId: tab.windowId,
                favicon: tab.favIconUrl || this.getFavicon(tab.url)
            }));
        } catch (error) {
            console.error('Error updating tab list:', error);
        }
    },

    getFavicon(url) {
        if (!url) return '';
        try {
            const domain = new URL(url).hostname;
            return `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
        } catch {
            return '';
        }
    },

    async toggleSwitcher(currentTab) {
        // Get only tabs from current window, sorted by recent usage
        const currentWindowTabs = this.tabs.filter(tab => tab.windowId === currentTab.windowId);
        const sortedTabs = this.sortTabsByRecentUsage(currentWindowTabs);

        // Send message to the current tab's content script
        try {
            await browser.tabs.sendMessage(currentTab.id, {
                action: 'toggleSwitcher',
                tabs: sortedTabs,
                currentTabId: currentTab.id
            });
        } catch (error) {
            console.error('Error toggling switcher:', error);
        }
    },

    sortTabsByRecentUsage(tabs) {
        // Create a map for quick lookup
        const tabMap = new Map(tabs.map(tab => [tab.id, tab]));
        const sortedTabs = [];

        // First, add tabs in order of recent usage (from tabAccessOrder)
        for (const tabId of this.tabAccessOrder) {
            if (tabMap.has(tabId)) {
                sortedTabs.push(tabMap.get(tabId));
                tabMap.delete(tabId);
            }
        }

        // Then add any remaining tabs that weren't in the access order
        // (new tabs or tabs from before the extension was loaded)
        for (const tab of tabMap.values()) {
            sortedTabs.push(tab);
        }

        return sortedTabs;
    },

    async switchToTab(tabId) {
        try {
            const tab = await browser.tabs.get(tabId);
            await browser.tabs.update(tabId, { active: true });
            await browser.windows.update(tab.windowId, { focused: true });
            this.updateTabAccessOrder(tabId);
        } catch (error) {
            console.error('Error switching tab:', error);
        }
    }
};

// Initialize when background script loads
tabSwitcher.init();
