// Input source helper for aios (TODO 463, docs/ARCHITECTURE.md 4.5.11).
//
// When a search / filter field gets focus, switch the macOS input source to a Latin one, and restore it when focus leaves. Neither Chromium nor Electron
// has a way to switch the input source (Chromium does not support `ime-mode`), so main keeps this small resident process
// running, which calls Carbon's Text Input Sources (waking a process on every focus would let the first typed
// character come out in Japanese during the tens of ms it takes to start).
//
// Usage: input-source-helper   (no arguments; one command per line on stdin)
//   ascii    ... remember the current input source and switch to a Latin one (an input source that can type ASCII).
//              Does nothing if it is already Latin (it does not remember either, so a later restore does nothing too).
//   restore  ... if ascii switched it, switch back to the remembered input source. But if the user changed the
//              input source themselves after the switch, do not restore (respect the user's choice).
//   ping     ... liveness check ({"ok":true,"pong":true}).
// Output is one JSON line at a time on stdout (one line per command, plus {"event":"user-changed"} when it sees the user switch).
// It prints nothing but input source IDs. It never sees the typed characters (this process does not touch key input).
//
// When stdin closes (main exited or crashed) it restores whatever it remembers, then exits. SIGTERM / SIGINT do the same.
// No permissions such as Accessibility are needed (TIS switching can be called with an ordinary app's permissions).
import Carbon
import Foundation

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
        let line = String(data: data, encoding: .utf8) else {
    print("{\"ok\":false,\"error\":\"encode\"}")
    fflush(stdout)
    return
  }
  print(line)
  fflush(stdout)
}

func sourceID(_ source: TISInputSource) -> String? {
  guard let raw = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else { return nil }
  return Unmanaged<CFString>.fromOpaque(raw).takeUnretainedValue() as String
}

func isASCIICapable(_ source: TISInputSource) -> Bool {
  guard let raw = TISGetInputSourceProperty(source, kTISPropertyInputSourceIsASCIICapable) else { return false }
  return CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(raw).takeUnretainedValue())
}

func currentSource() -> TISInputSource? {
  TISCopyCurrentKeyboardInputSource()?.takeRetainedValue()
}

/// State is touched on the main thread only (stdin, notifications and signals are all routed to the main queue).
final class Switcher {
  /// The input source before ascii switched it. nil if it has not switched.
  private var saved: TISInputSource?
  /// ID of the input source ascii selected. The difference between this and the current ID tells whether the user changed it.
  private var selectedID: String?

  func ascii() -> [String: Any] {
    if saved != nil { return ["ok": true, "switched": false, "reason": "already-switched"] }
    guard let current = currentSource() else { return ["ok": false, "error": "no-current"] }
    if isASCIICapable(current) {
      return ["ok": true, "switched": false, "reason": "already-ascii"]
    }
    guard let target = TISCopyCurrentASCIICapableKeyboardInputSource()?.takeRetainedValue() else {
      return ["ok": false, "error": "no-ascii-source"]
    }
    let status = TISSelectInputSource(target)
    if status != noErr { return ["ok": false, "error": "select", "status": Int(status)] }
    saved = current
    selectedID = sourceID(target)
    return ["ok": true, "switched": true, "from": sourceID(current) ?? "", "to": selectedID ?? ""]
  }

  func restore() -> [String: Any] {
    guard let back = saved else { return ["ok": true, "restored": false, "reason": "nothing"] }
    let expected = selectedID
    saved = nil
    selectedID = nil
    if let current = currentSource(), let expected, sourceID(current) != expected {
      // The user changed it themselves after the switch. Respect that choice and do not restore.
      return ["ok": true, "restored": false, "reason": "user-changed"]
    }
    let status = TISSelectInputSource(back)
    if status != noErr { return ["ok": false, "error": "select", "status": Int(status)] }
    return ["ok": true, "restored": true, "to": sourceID(back) ?? ""]
  }

  /// The input source changed (OS notification). Ignore the notification for our own switch (current ID = selected ID).
  func sourceChanged() {
    guard saved != nil, let expected = selectedID, let current = currentSource() else { return }
    if sourceID(current) == expected { return }
    // The user switched it themselves inside the field. From now on do not restore for this switch.
    saved = nil
    selectedID = nil
    emit(["event": "user-changed"])
  }
}

let switcher = Switcher()

func finish() -> Never {
  _ = switcher.restore()
  exit(0)
}

func handle(_ line: String) {
  switch line.trimmingCharacters(in: .whitespacesAndNewlines) {
  case "ascii": emit(switcher.ascii())
  case "restore": emit(switcher.restore())
  case "ping": emit(["ok": true, "pong": true])
  case "quit": finish()
  case "": break
  default: emit(["ok": false, "error": "unknown-command"])
  }
}

// Watch for input source changes (the user switched with Ctrl+Space or similar).
DistributedNotificationCenter.default().addObserver(
  forName: NSNotification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String),
  object: nil,
  queue: .main
) { _ in
  switcher.sourceChanged()
}

// Restore before exiting on termination signals too.
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
  let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  source.setEventHandler { finish() }
  source.resume()
  signalSources.append(source)
}

// Read stdin on a separate thread and hand it to the main queue one line at a time. On EOF (main exited or crashed), restore and exit.
Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    DispatchQueue.main.async { handle(line) }
  }
  DispatchQueue.main.async { finish() }
}

emit(["ok": true, "ready": true])
// Notifications (DistributedNotificationCenter) are delivered on main's run loop, so run the run loop instead of dispatchMain.
RunLoop.main.run()
