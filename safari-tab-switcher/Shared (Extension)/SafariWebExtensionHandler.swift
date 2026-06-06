//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Created by Mustafa Siddiqui on 6/4/26.
//

import SafariServices
import os.log

let appGroupID = "group.personal.safari-tab-switcher"
let showNotification = "ShowTabSwitcherDarwin"
let selectionNotification = "TabSwitcherSelectionDarwin"

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "Received message from browser.runtime.sendNativeMessage: %@", String(describing: message))

        guard let dict = message as? [String: Any],
              let action = dict["action"] as? String,
              action == "showSwitcher",
              let tabs = dict["tabs"] as? [[String: Any]],
              let jsonData = try? JSONSerialization.data(withJSONObject: tabs, options: []),
              let jsonString = String(data: jsonData, encoding: .utf8),
              let sharedDefaults = UserDefaults(suiteName: appGroupID) else {
            os_log(.default, "ERROR: bad payload or could not access App Group %@", appGroupID)
            complete(context: context, selectedTabId: -1)
            return
        }

        // Clear any stale selection from a previous invocation, then hand the
        // tabs to the macOS app via the App Group + a Darwin notification.
        sharedDefaults.removeObject(forKey: "selectedTabId")
        sharedDefaults.set(jsonString, forKey: "latestTabsJSON")

        // Keep THIS request open and wait for the app to post back the user's
        // choice. background.js is awaiting this response and performs the
        // actual browser.tabs.update with the real WebExtension tab id.
        waitForSelection(sharedDefaults: sharedDefaults) { [weak self] selectedTabId in
            self?.complete(context: context, selectedTabId: selectedTabId)
        }

        let notifyCenter = CFNotificationCenterGetDarwinNotifyCenter()
        CFNotificationCenterPostNotification(
            notifyCenter,
            CFNotificationName(showNotification as CFString),
            nil, nil, true
        )
        os_log(.default, "Saved tabs to App Group and posted show notification")
    }

    /// Listens for the app's "selection made" Darwin notification, then reads
    /// the chosen tab id out of the shared App Group. Times out so the request
    /// never hangs forever if the user dismisses the overlay.
    private func waitForSelection(sharedDefaults: UserDefaults, completion: @escaping (Int) -> Void) {
        let center = NotificationCenter.default
        var observer: NSObjectProtocol?
        var didFinish = false

        let finish: (Int) -> Void = { selectedTabId in
            if didFinish { return }
            didFinish = true
            if let observer = observer {
                center.removeObserver(observer)
            }
            DarwinNotificationBridge.shared.stopObserving(selectionNotification)
            completion(selectedTabId)
        }

        observer = center.addObserver(forName: .tabSwitcherSelectionMade, object: nil, queue: .main) { _ in
            sharedDefaults.synchronize()
            let id = sharedDefaults.object(forKey: "selectedTabId") as? Int ?? -1
            finish(id)
        }

        DarwinNotificationBridge.shared.startObserving(selectionNotification) {
            NotificationCenter.default.post(name: .tabSwitcherSelectionMade, object: nil)
        }

        // Safety timeout: if no selection arrives (overlay dismissed), resolve
        // with -1 so background.js simply does nothing.
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
            finish(-1)
        }
    }

    private func complete(context: NSExtensionContext, selectedTabId: Int) {
        let response = NSExtensionItem()
        let payload: [String: Any] = ["selectedTabId": selectedTabId]
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: payload]
        } else {
            response.userInfo = ["message": payload]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}

extension Notification.Name {
    static let tabSwitcherSelectionMade = Notification.Name("tabSwitcherSelectionMade")
}

/// Bridges cross-process Darwin notifications (which use C callbacks with no
/// captured context) to Swift closures keyed by notification name.
final class DarwinNotificationBridge {
    static let shared = DarwinNotificationBridge()

    private var handlers: [String: () -> Void] = [:]
    private let lock = NSLock()

    private init() {}

    func startObserving(_ name: String, handler: @escaping () -> Void) {
        lock.lock()
        handlers[name] = handler
        lock.unlock()

        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = UnsafeRawPointer(Unmanaged.passUnretained(self).toOpaque())
        CFNotificationCenterAddObserver(
            center,
            observer,
            { _, _, name, _, _ in
                guard let name = name else { return }
                DarwinNotificationBridge.shared.dispatch(name.rawValue as String)
            },
            name as CFString,
            nil,
            .deliverImmediately
        )
    }

    func stopObserving(_ name: String) {
        lock.lock()
        handlers[name] = nil
        lock.unlock()

        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = UnsafeRawPointer(Unmanaged.passUnretained(self).toOpaque())
        CFNotificationCenterRemoveObserver(
            center,
            observer,
            CFNotificationName(name as CFString),
            nil
        )
    }

    private func dispatch(_ name: String) {
        lock.lock()
        let handler = handlers[name]
        lock.unlock()
        handler?()
    }
}
