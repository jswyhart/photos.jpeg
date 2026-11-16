// photos.jpeg for macOS — native menu bar. Items send command names to the editor
// (PJ.App.runCommand). Single-key shortcuts (G, D, R, P, 1–5 …) are handled by the editor
// itself so they never fire while typing, so only ⌘-shortcuts are bound here.
import AppKit

enum MenuBuilder {
    private static weak var target: AppDelegate?

    static func install(target t: AppDelegate) {
        target = t
        let main = NSMenu()

        // App menu
        let appMenu = NSMenu()
        appMenu.addItem(cmd("About photos.jpeg", "about"))
        appMenu.addItem(.separator())
        appMenu.addItem(cmd("Settings…", "preferences", ",", [.command]))
        appMenu.addItem(.separator())
        let services = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        services.submenu = NSMenu()
        NSApp.servicesMenu = services.submenu
        appMenu.addItem(services)
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(title: "Hide photos.jpeg", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        let hideOthers = NSMenuItem(title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(NSMenuItem(title: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: ""))
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(title: "Quit photos.jpeg", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        add(main, "photos.jpeg", appMenu)

        // File
        let file = NSMenu(title: "File")
        file.addItem(cmd("Import Photos…", "import", "i", [.command, .shift]))
        file.addItem(cmd("Import Folder…", "importFolder", "o", [.command, .shift]))
        file.addItem(.separator())
        file.addItem(cmd("Export…", "export", "e", [.command, .shift]))
        file.addItem(cmd("Export with Previous", "exportPrevious", "e", [.command, .option, .shift]))
        file.addItem(.separator())
        file.addItem(cmd("Show in Finder", "showInFolder"))
        file.addItem(.separator())
        file.addItem(cmd("Read Metadata from Files (XMP)", "xmpRead"))
        file.addItem(cmd("Save Metadata to Files (XMP)", "xmpWrite", "s", [.command]))
        file.addItem(cmd("Slideshow", "slideshow", "\r", [.command]))
        file.addItem(.separator())
        file.addItem(cmd("Remove from Catalog", "remove"))
        file.addItem(.separator())
        file.addItem(NSMenuItem(title: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        add(main, "File", file)

        // Edit — Cut/Copy/Paste use the responder chain so text fields keep working.
        let edit = NSMenu(title: "Edit")
        edit.addItem(cmd("Undo", "undo", "z", [.command]))
        edit.addItem(cmd("Redo", "redo", "z", [.command, .shift]))
        edit.addItem(.separator())
        edit.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        edit.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        edit.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        edit.addItem(cmd("Select All", "selectAll", "a", [.command]))
        edit.addItem(cmd("Select None", "deselect", "d", [.command]))
        edit.addItem(.separator())
        edit.addItem(cmd("Copy Settings…", "copySettings", "c", [.command, .shift]))
        edit.addItem(cmd("Paste Settings", "pasteSettings", "v", [.command, .shift]))
        edit.addItem(cmd("Sync Settings…", "syncSettings", "s", [.command, .shift]))
        add(main, "Edit", edit)

        // Photo
        let photo = NSMenu(title: "Photo")
        photo.addItem(cmd("Create Virtual Copy", "virtualCopy", "'", [.command]))
        photo.addItem(.separator())
        photo.addItem(cmd("Rotate Left", "rotateLeft", "[", [.command]))
        photo.addItem(cmd("Rotate Right", "rotateRight", "]", [.command]))
        photo.addItem(cmd("Flip Horizontal", "flipH"))
        photo.addItem(cmd("Flip Vertical", "flipV"))
        photo.addItem(.separator())
        let rating = NSMenu(title: "Set Rating")
        for n in 0...5 { rating.addItem(cmd(n == 0 ? "None   (0)" : String(repeating: "★", count: n) + "   (\(n))", "rating:\(n)")) }
        photo.addItem(sub("Set Rating", rating))
        let flag = NSMenu(title: "Set Flag")
        flag.addItem(cmd("Pick   (P)", "flag:1")); flag.addItem(cmd("Unflagged   (U)", "flag:0")); flag.addItem(cmd("Reject   (X)", "flag:-1"))
        photo.addItem(sub("Set Flag", flag))
        let label = NSMenu(title: "Color Label")
        for (name, key) in [("Red", "red"), ("Yellow", "yellow"), ("Green", "green"), ("Blue", "blue"), ("Purple", "purple"), ("None", "")] {
            label.addItem(cmd(name, "label:\(key)"))
        }
        photo.addItem(sub("Color Label", label))
        photo.addItem(.separator())
        photo.addItem(cmd("Auto Tone", "autoTone", "u", [.command, .shift]))
        photo.addItem(cmd("Reset Develop Settings", "reset", "r", [.command, .shift]))
        photo.addItem(.separator())
        photo.addItem(cmd("Merge to HDR…", "mergeHdr"))
        photo.addItem(cmd("Merge to HDR (editable DNG)…", "mergeHdrDng"))
        photo.addItem(cmd("Merge to Panorama…", "mergePano"))
        photo.addItem(cmd("Merge to Focus Stack…", "mergeStack"))
        photo.addItem(cmd("Rename or Move…", "batchRename"))
        photo.addItem(.separator())
        photo.addItem(cmd("New Snapshot…", "newSnapshot", "n", [.command]))
        photo.addItem(cmd("New Develop Preset…", "newPreset", "n", [.command, .shift]))
        add(main, "Photo", photo)

        // Tools
        let tools = NSMenu(title: "Tools")
        tools.addItem(cmd("Crop & Straighten   (R)", "crop"))
        tools.addItem(cmd("Spot Removal   (Q)", "spot"))
        tools.addItem(cmd("Masking   (M)", "mask"))
        tools.addItem(.separator())
        tools.addItem(cmd("Find Duplicates…", "duplicates"))
        add(main, "Tools", tools)

        // View
        let view = NSMenu(title: "View")
        view.addItem(cmd("Library   (G)", "library"))
        view.addItem(cmd("Develop   (D)", "develop"))
        view.addItem(cmd("Map   (M)", "map"))
        view.addItem(.separator())
        view.addItem(cmd("Show Faces", "toggleFaces"))
        view.addItem(cmd("Before / After   (Y)", "beforeAfter"))
        view.addItem(cmd("Show Clipping   (J)", "clipping"))
        view.addItem(cmd("Zoom to Fit", "zoomFit", "0", [.command]))
        view.addItem(cmd("Zoom 100%", "zoom100", "1", [.command]))
        view.addItem(.separator())
        view.addItem(cmd("Toggle Side Panels   (Tab)", "togglePanels"))
        view.addItem(cmd("Toggle All Panels   (⇧Tab)", "toggleAllPanels"))
        let fs = NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        view.addItem(fs)
        view.addItem(.separator())
        let reload = NSMenuItem(title: "Reload Interface", action: #selector(AppDelegate.reloadUI(_:)), keyEquivalent: "r")
        reload.keyEquivalentModifierMask = [.command, .option]
        reload.target = t
        view.addItem(reload)
        add(main, "View", view)

        // Window
        let window = NSMenu(title: "Window")
        window.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        window.addItem(NSMenuItem(title: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""))
        NSApp.windowsMenu = window
        add(main, "Window", window)

        // Help
        let help = NSMenu(title: "Help")
        help.addItem(cmd("Keyboard Shortcuts", "shortcuts", "/", [.command]))
        help.addItem(cmd("Clean Up Catalog…", "cleanCatalog"))
        help.addItem(cmd("Catalog Backups…", "catalogBackups"))
        let folder = NSMenuItem(title: "Open Catalog Folder", action: #selector(AppDelegate.openCatalogFolder(_:)), keyEquivalent: "")
        folder.target = t
        help.addItem(folder)
        NSApp.helpMenu = help
        add(main, "Help", help)

        NSApp.mainMenu = main
    }

    private static func cmd(_ title: String, _ command: String, _ key: String = "", _ mods: NSEvent.ModifierFlags = []) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(AppDelegate.menuCommand(_:)), keyEquivalent: key)
        if !key.isEmpty { item.keyEquivalentModifierMask = mods }
        item.representedObject = command
        item.target = target
        return item
    }

    private static func sub(_ title: String, _ menu: NSMenu) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = menu
        return item
    }

    private static func add(_ main: NSMenu, _ title: String, _ menu: NSMenu) {
        menu.title = title
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = menu
        main.addItem(item)
    }
}
