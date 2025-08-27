if (!window.TabSwitcherUI) {
    class TabSwitcherUI {
        constructor() {
            this.isVisible = false;
            this.selectedIndex = 0;
            this.tabs = [];
            this.filteredTabs = [];
            this.searchQuery = '';
            this.currentTabId = null;
            this.setupMessageListener();
            this.setupKeyboardListener();
        }

        setupMessageListener() {
            // Listen for messages from background script
            browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
                if (message.action === 'toggleSwitcher') {
                    this.handleToggle(message.tabs, message.currentTabId);
                }
            });
        }

        setupKeyboardListener() {
            console.log('Tab Switcher: Setting up keyboard listener');
            // Listen for Ctrl+K globally on the page
            document.addEventListener('keydown', (e) => {
                console.log('Tab Switcher: Key pressed:', e.key, 'Ctrl:', e.ctrlKey);
                if (e.ctrlKey && e.key === 'k' && !e.shiftKey && !e.altKey && !e.metaKey) {
                    console.log('Tab Switcher: Ctrl+K detected!');
                    e.preventDefault();
                    this.requestToggle();
                }
            });
        }

        async requestToggle() {
            console.log('Tab Switcher: Requesting toggle');
            try {
                // Request tab list from background script and toggle
                await browser.runtime.sendMessage({ action: 'toggleSwitcher' });
                console.log('Tab Switcher: Message sent to background');
            } catch (error) {
                console.error('Tab Switcher: Error requesting toggle:', error);
            }
        }

        handleToggle(tabs, currentTabId) {
            this.tabs = tabs || [];
            this.currentTabId = currentTabId;
            this.filteredTabs = [...this.tabs];

            if (this.isVisible) {
                this.hide();
            } else {
                this.show();
            }
        }

        show() {
            this.isVisible = true;
            this.selectedIndex = 0;
            this.searchQuery = '';

            // Move current tab to second position (first will be most recent non-current)
            const currentIndex = this.tabs.findIndex(tab => tab.id === this.currentTabId);
            if (currentIndex > 0) {
                const currentTab = this.tabs[currentIndex];
                this.tabs.splice(currentIndex, 1);
                this.tabs.splice(1, 0, currentTab);
            }

            this.filteredTabs = [...this.tabs];
            this.render();
            this.setupModalKeyboardListeners();
        }

        hide() {
            this.isVisible = false;
            this.removeModalKeyboardListeners();
            const overlay = document.getElementById('tab-switcher-overlay');
            if (overlay) {
                overlay.remove();
            }
        }

        render() {
            // Remove existing overlay
            const existing = document.getElementById('tab-switcher-overlay');
            if (existing) existing.remove();

            const overlay = document.createElement('div');
            overlay.id = 'tab-switcher-overlay';
            overlay.innerHTML = `
      <div class="tab-switcher-modal">
        <div class="tab-switcher-search">
          <input type="text" id="tab-search-input" placeholder="Search tabs..." value="${this.searchQuery}">
        </div>
        <div class="tab-switcher-list">
          ${this.filteredTabs.map((tab, index) => `
            <div class="tab-item ${index === this.selectedIndex ? 'selected' : ''}" data-index="${index}">
              ${tab.favicon && tab.favicon.trim()
                    ? `<img class="tab-favicon" src="${tab.favicon}" alt="" onerror="this.style.display='none'">`
                    : `<span class="tab-favicon-fallback" title="No favicon">💀</span>`
                }
              <div class="tab-info">
                <div class="tab-title">${this.escapeHtml(tab.title)}</div>
                <div class="tab-url">${this.escapeHtml(this.shortenUrl(tab.url))}</div>
              </div>
              ${tab.active ? '<div class="tab-active-indicator">●</div>' : ''}
            </div>
          `).join('')}
        </div>
        <div class="tab-switcher-footer">
          <span>↑↓ Navigate • Enter Select • Esc Cancel • Ctrl+K Toggle</span>
        </div>
      </div>
    `;

            document.body.appendChild(overlay);

            // Focus search input
            const searchInput = document.getElementById('tab-search-input');
            searchInput.focus();
            searchInput.setSelectionRange(this.searchQuery.length, this.searchQuery.length);
        }

        setupModalKeyboardListeners() {
            this.ctrlKeyDown = false;

            this.modalKeyHandler = (e) => {
                if (!this.isVisible) return;

                // Prevent propagation for handled keys
                const handledKeys = [
                    'Escape', 'ArrowDown', 'ArrowUp', 'Enter', 'k'
                ];
                if (
                    handledKeys.includes(e.key) ||
                    (e.ctrlKey && e.key.toLowerCase() === 'k')
                ) {
                    e.preventDefault();
                    e.stopPropagation();
                }

                // Track Ctrl key state
                if (e.type === 'keydown' && e.ctrlKey) {
                    this.ctrlKeyDown = true;
                }

                // Ctrl+K cycles next, Ctrl+Shift+K cycles previous
                if (e.ctrlKey && e.key.toLowerCase() === 'k' && !e.altKey && !e.metaKey) {
                    if (e.shiftKey) {
                        // Previous tab
                        this.selectedIndex = (this.selectedIndex - 1 + this.filteredTabs.length) % this.filteredTabs.length;
                    } else {
                        // Next tab
                        this.selectedIndex = (this.selectedIndex + 1) % this.filteredTabs.length;
                    }
                    this.updateSelection();
                    return;
                }

                switch (e.key) {
                    case 'Escape':
                        this.hide();
                        break;
                    case 'ArrowDown':
                        this.selectedIndex = Math.min(this.selectedIndex + 1, this.filteredTabs.length - 1);
                        this.updateSelection();
                        break;
                    case 'ArrowUp':
                        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
                        this.updateSelection();
                        break;
                    case 'Enter':
                        this.selectTab();
                        break;
                }
            };

            this.ctrlKeyUpHandler = (e) => {
                if (!this.isVisible) return;
                if (e.key === 'Control' && this.ctrlKeyDown) {
                    this.ctrlKeyDown = false;
                    this.selectTab();
                }
            };

            document.addEventListener('keydown', this.modalKeyHandler, true);
            document.addEventListener('keyup', this.ctrlKeyUpHandler, true);

            const searchInput = document.getElementById('tab-search-input');
            if (searchInput) {
                searchInput.addEventListener('input', (e) => {
                    this.searchQuery = e.target.value;
                    this.filterTabs();
                });
            }
        }

        removeModalKeyboardListeners() {
            if (this.modalKeyHandler) {
                document.removeEventListener('keydown', this.modalKeyHandler, true);
                this.modalKeyHandler = null;
            }
            if (this.ctrlKeyUpHandler) {
                document.removeEventListener('keyup', this.ctrlKeyUpHandler, true);
                this.ctrlKeyUpHandler = null;
            }
        }

        filterTabs() {
            if (!this.searchQuery.trim()) {
                this.filteredTabs = [...this.tabs];
            } else {
                const query = this.searchQuery.toLowerCase();
                this.filteredTabs = this.tabs.filter(tab =>
                    tab.title.toLowerCase().includes(query) ||
                    tab.url.toLowerCase().includes(query)
                );
            }

            this.selectedIndex = 0;
            this.render();
        }

        updateSelection() {
            const items = document.querySelectorAll('.tab-item');
            items.forEach((item, index) => {
                item.classList.toggle('selected', index === this.selectedIndex);
            });

            // Scroll selected item into view
            const selected = items[this.selectedIndex];
            if (selected) {
                selected.scrollIntoView({ block: 'nearest' });
            }
        }

        async selectTab() {
            if (this.filteredTabs[this.selectedIndex]) {
                const selectedTab = this.filteredTabs[this.selectedIndex];
                try {
                    await browser.runtime.sendMessage({
                        action: 'switchToTab',
                        tabId: selectedTab.id
                    });
                    this.hide();
                } catch (error) {
                    console.error('Error selecting tab:', error);
                }
            }
        }

        escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        shortenUrl(url) {
            if (!url) return '';
            try {
                const urlObj = new URL(url);
                return urlObj.hostname + urlObj.pathname;
            } catch {
                return url.length > 60 ? url.substring(0, 60) + '...' : url;
            }
        }
    }
    window.TabSwitcherUI = TabSwitcherUI;
}

// Initialize the tab switcher UI (only if it doesn't already exist)
if (!window.tabSwitcherUI) {
    window.tabSwitcherUI = new window.TabSwitcherUI();
}
