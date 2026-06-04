//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Created by Mustafa Siddiqui on 6/4/26.
//

import SafariServices
import os.log

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

        if let dict = message as? [String: Any],
           let action = dict["action"] as? String,
           action == "showSwitcher",
           let tabs = dict["tabs"] as? [[String: Any]] {
            
            // Serialize tabs to JSON string
            if let jsonData = try? JSONSerialization.data(withJSONObject: tabs, options: []),
               let jsonString = String(data: jsonData, encoding: .utf8) {
                
                // Write to shared App Group
                if let sharedDefaults = UserDefaults(suiteName: "group.personal.safari-tab-switcher") {
                    sharedDefaults.set(jsonString, forKey: "latestTabsJSON")
                    sharedDefaults.synchronize()
                    
                    // Post Darwin Notification (Allowed in Sandbox)
                    let notificationName = CFNotificationName("ShowTabSwitcherDarwin" as CFString)
                    let notifyCenter = CFNotificationCenterGetDarwinNotifyCenter()
                    CFNotificationCenterPostNotification(notifyCenter, notificationName, nil, nil, true)
                    
                    os_log(.default, "Saved to App Group and posted Darwin Notification")
                } else {
                    os_log(.default, "ERROR: Could not access App Group group.personal.safari-tab-switcher")
                }
            }
        }

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [ SFExtensionMessageKey: [ "status": "success" ] ]
        } else {
            response.userInfo = [ "message": [ "status": "success" ] ]
        }

        context.completeRequest(returningItems: [ response ], completionHandler: nil)
    }

}

