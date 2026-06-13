//
//  AppDelegate.swift
//  macOS (App)
//
//  Created by Mustafa Siddiqui on 6/4/26.
//

import Cocoa
import SwiftUI
import SafariServices
import Combine
import ServiceManagement

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    var switcherWindow: NSWindow?
    var tabManager = TabManager()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Run as a background agent (hide from Dock)
        NSApp.setActivationPolicy(.accessory)

        // Register as a login item so the agent is always running to receive
        // the Darwin notification posted by the Safari extension. Without this,
        // the extension fires but nothing listens (the overlay never appears).
        registerAsLoginItem()

        // Listen for the Darwin Notification from the extension
        let notifyCenter = CFNotificationCenterGetDarwinNotifyCenter()
        let notificationName = CFNotificationName("ShowTabSwitcherDarwin" as CFString)
        
        let observer = UnsafeRawPointer(Unmanaged.passUnretained(self).toOpaque())
        CFNotificationCenterAddObserver(notifyCenter, observer, { (center, observer, name, object, userInfo) in
            let mySelf = Unmanaged<AppDelegate>.fromOpaque(observer!).takeUnretainedValue()
            mySelf.handleDarwinNotification()
        }, notificationName.rawValue, nil, .deliverImmediately)
        
        tabManager.onSelect = { [weak self] selectedTab in
            self?.switchTo(tab: selectedTab)
            self?.switcherWindow?.orderOut(nil)
            if let safariApp = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first {
                safariApp.activate()
            }
        }
    }
    
    func registerAsLoginItem() {
        do {
            if SMAppService.mainApp.status != .enabled {
                try SMAppService.mainApp.register()
            }
        } catch {
            print("Failed to register as login item: \(error)")
        }
    }

    func handleDarwinNotification() {
        // Read the tabs from the shared App Group
        guard let sharedDefaults = UserDefaults(suiteName: "group.personal.safari-tab-switcher"),
              let jsonString = sharedDefaults.string(forKey: "latestTabsJSON"),
              let jsonData = jsonString.data(using: .utf8),
              let tabsArray = try? JSONSerialization.jsonObject(with: jsonData, options: []) as? [[String: Any]] else {
            return
        }
        
        let tabs = tabsArray.compactMap { dict -> TabItem? in
            guard let id = dict["id"] as? Int,
                  let title = dict["title"] as? String,
                  let url = dict["url"] as? String,
                  let active = dict["active"] as? Bool else { return nil }
            let windowId = dict["windowId"] as? Int
            let favicon = dict["favicon"] as? String
            return TabItem(id: id, title: title, url: url, active: active, windowId: windowId, favicon: favicon)
        }
        
        DispatchQueue.main.async {
            self.tabManager.updateTabs(tabs)
            self.displayWindow()
        }
    }

    func displayWindow() {
        if switcherWindow == nil {
            let view = SwitcherView(manager: tabManager)
            let hostingView = NSHostingView(rootView: view)
            // Let the window track the SwiftUI view's intrinsic size so the
            // Liquid Glass shape isn't clipped and the drop shadow hugs it.
            hostingView.sizingOptions = [.standardBounds]

            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 560, height: 220),
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered, defer: false
            )

            window.isOpaque = false
            window.backgroundColor = .clear
            window.hasShadow = true
            window.level = .floating
            window.contentView = hostingView
            window.setContentSize(hostingView.fittingSize)
            window.center()

            // Allow the window to receive keyboard events even as a nonactivating panel
            window.makeKeyAndOrderFront(nil)

            self.switcherWindow = window
        } else {
            self.switcherWindow?.center()
            self.switcherWindow?.makeKeyAndOrderFront(nil)
        }

        // Ensure any previous selection is cleared in the App Group
        if let sharedDefaults = UserDefaults(suiteName: "group.personal.safari-tab-switcher") {
            sharedDefaults.removeObject(forKey: "selectedTabId")
            sharedDefaults.synchronize()
        }
        
        NSApp.activate(ignoringOtherApps: true)
    }

    func switchTo(tab: TabItem) {
        // Write the chosen WebExtension tab id to the shared App Group and post
        // a Darwin notification. The extension's native handler (still holding
        // the sendNativeMessage request open) reads it and resolves back to
        // background.js, which performs browser.tabs.update with that exact id.
        // Using the id rather than the URL means duplicate-URL tabs are handled
        // correctly.
        if let sharedDefaults = UserDefaults(suiteName: "group.personal.safari-tab-switcher") {
            sharedDefaults.set(tab.id, forKey: "selectedTabId")
            sharedDefaults.synchronize()
        }

        let notifyCenter = CFNotificationCenterGetDarwinNotifyCenter()
        CFNotificationCenterPostNotification(
            notifyCenter,
            CFNotificationName("TabSwitcherSelectionDarwin" as CFString),
            nil, nil, true
        )
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false // Stay running in the background
    }

}

struct TabItem: Identifiable, Hashable {
    let id: Int
    let title: String
    let url: String
    let active: Bool
    let windowId: Int?
    let favicon: String?
}

class TabManager: ObservableObject {
    @Published var tabs: [TabItem] = []
    @Published var selectedIndex: Int = 0
    
    var onSelect: ((TabItem) -> Void)?

    func updateTabs(_ newTabs: [TabItem]) {
        self.tabs = newTabs
        
        // Select second tab if current is first (MRU logic)
        if tabs.count > 1 && tabs[0].active {
            self.selectedIndex = 1
        } else {
            self.selectedIndex = 0
        }
    }

    func moveSelection(delta: Int) {
        if tabs.isEmpty { return }
        var newIndex = selectedIndex + delta
        // Wrap around
        if newIndex < 0 { newIndex = tabs.count - 1 }
        if newIndex >= tabs.count { newIndex = 0 }
        selectedIndex = newIndex
    }
    
    func selectCurrent() {
        guard selectedIndex >= 0 && selectedIndex < tabs.count else { return }
        onSelect?(tabs[selectedIndex])
    }
}

struct SwitcherView: View {
    @ObservedObject var manager: TabManager
    @State private var eventMonitor: Any?

    @Namespace private var glassNamespace

    var body: some View {
        VStack(spacing: 14) {
            // Horizontal row of tab icons inside a single Liquid Glass surface,
            // mirroring the macOS 26 cmd+tab switcher bar.
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    GlassEffectContainer(spacing: 14) {
                        HStack(spacing: 14) {
                            ForEach(Array(manager.tabs.enumerated()), id: \.element.id) { index, tab in
                                AppIconView(
                                    tab: tab,
                                    isSelected: index == manager.selectedIndex,
                                    namespace: glassNamespace
                                )
                                .id(index)
                                .onTapGesture {
                                    manager.selectedIndex = index
                                    manager.selectCurrent()
                                }
                            }
                        }
                        .padding(16)
                    }
                }
                .onChange(of: manager.selectedIndex) { _, newIndex in
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) {
                        proxy.scrollTo(newIndex, anchor: .center)
                    }
                }
            }
            .frame(height: 108)

            // Selected tab title
            if manager.tabs.indices.contains(manager.selectedIndex) {
                Text(manager.tabs[manager.selectedIndex].title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 4)
            }
        }
        .padding(.vertical, 18)
        .frame(width: 560)
        .fixedSize(horizontal: false, vertical: true)
        // .clear is the more transparent Liquid Glass variant — it lets much more
        // of the backdrop through instead of reading as a tinted slab, which is the
        // see-through look we're after on both light and dark pages.
        .glassEffect(.clear, in: .rect(cornerRadius: 28))
        .onAppear {
            setupEventMonitor()
            
            // Check if Control key was already released before the window appeared
            // If so, execute the switch immediately (like a quick tap of Ctrl+Tab)
            if !NSEvent.modifierFlags.contains(.control) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    manager.selectCurrent()
                }
            }
        }
        .onDisappear {
            if let monitor = eventMonitor {
                NSEvent.removeMonitor(monitor)
            }
        }
    }
    
    private func setupEventMonitor() {
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged, .keyDown]) { event in
            // Listen for Control key release
            if event.type == .flagsChanged {
                if !event.modifierFlags.contains(.control) {
                    manager.selectCurrent()
                    return nil
                }
            }
            // Listen for 'E' key to cycle, or Right/Left arrows
            else if event.type == .keyDown {
                if event.keyCode == 14 { // 'e' key
                    let forward = !event.modifierFlags.contains(.shift)
                    manager.moveSelection(delta: forward ? 1 : -1)
                    return nil
                } else if event.keyCode == 124 || event.keyCode == 125 || event.keyCode == 48 { // Right, Down, Tab
                    manager.moveSelection(delta: 1)
                    return nil
                } else if event.keyCode == 123 || event.keyCode == 126 { // Left, Up
                    manager.moveSelection(delta: -1)
                    return nil
                } else if event.keyCode == 53 { // Esc
                    NSApp.windows.forEach { $0.orderOut(nil) }
                    return nil
                } else if event.keyCode == 36 { // Enter
                    manager.selectCurrent()
                    return nil
                }
            }
            return event
        }
    }
}

struct AppIconView: View {
    let tab: TabItem
    let isSelected: Bool
    let namespace: Namespace.ID

    var body: some View {
        FaviconView(urlString: tab.favicon, title: tab.title)
            .frame(width: 44, height: 44)
            .padding(14)
            .glassEffect(
                isSelected ? .clear.tint(.accentColor.opacity(0.275)).interactive() : .clear,
                in: .rect(cornerRadius: 18)
            )
            // A solid border on the selected pill guarantees it's distinguishable
            // even when the favicon is white-on-white or black-on-black with no
            // background variance for the clear glass to pick up. The thin dark
            // outer edge keeps the accent line legible on light backgrounds too,
            // so the border never "bleeds" into a same-colored page.
            .overlay {
                if isSelected {
                    RoundedRectangle(cornerRadius: 18)
                        .strokeBorder(Color.accentColor, lineWidth: 2)
                        .overlay(
                            RoundedRectangle(cornerRadius: 18)
                                .inset(by: -1)
                                .strokeBorder(Color.black.opacity(0.25), lineWidth: 1)
                        )
                }
            }
            .glassEffectID(tab.id, in: namespace)
            .scaleEffect(isSelected ? 1.04 : 1.0)
            .animation(.spring(response: 0.35, dampingFraction: 0.75), value: isSelected)
    }
}

/// Loads a tab's favicon (http(s) or data: URI), falling back to the title's
/// initial letter while loading or when no favicon is available.
struct FaviconView: View {
    let urlString: String?
    let title: String

    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image = image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .cornerRadius(6)
            } else {
                Text(initial)
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .foregroundColor(.secondary)
            }
        }
        .task(id: urlString) {
            await loadFavicon()
        }
    }

    private var initial: String {
        let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return clean.isEmpty ? "🌐" : String(clean.prefix(1)).uppercased()
    }

    private func loadFavicon() async {
        guard let urlString = urlString,
              !urlString.isEmpty,
              let url = URL(string: urlString) else {
            image = nil
            return
        }

        // data: URIs aren't handled by URLSession, so decode them directly.
        if url.scheme == "data" {
            if let comma = urlString.firstIndex(of: ","),
               let data = Data(base64Encoded: String(urlString[urlString.index(after: comma)...])),
               let decoded = NSImage(data: data) {
                image = decoded
            }
            return
        }

        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let decoded = NSImage(data: data) else {
            return
        }
        image = decoded
    }
}

