// Voice input helper for aios (item 226, docs/ARCHITECTURE.md 4.5.10).
//
// Usage: speech-helper <locale> <wav>
//   locale ... ja-JP / en-US (main decides it from the display language)
//   wav    ... a 16 kHz / 16 bit / mono WAV (a temporary file main wrote to os.tmpdir(); main deletes it)
//
// Output is a single JSON line on stdout:
//   success {"text": "...", "ms": 123, "engine": "dictation" | "sf"}           exit code 0
//   failure {"error": "locale-unsupported" | "asset" | "read" | "auth" | "failed", "engine": ...}  exit code 1
// The transcript goes to stdout only (it is kept in no file or log). Nothing is written to stderr.
//
// Recognition happens on the device only (on-device):
//   - macOS 26 and later: SpeechAnalyzer + DictationTranscriber (.longDictation). In spike 28 it added punctuation, garbled Latin letters
//     the least, and never asked for the speech recognition permission with file input. If the language asset is missing, it is downloaded
//     with AssetInventory (16.7 s for en_US; main's timeout allows for this).
//   - Earlier: SFSpeechRecognizer + requiresOnDeviceRecognition. This needs the speech recognition permission, and the prompt appears
//     under the name of the "responsible process" (aios.app). If its Info.plist lacks NSSpeechRecognitionUsageDescription,
//     TCC denies without showing the prompt and the process aborts (spike 28). That is why scripts/make-app.mjs adds the key.
// It does not touch the microphone (recording is done in aios's renderer).
import AVFAudio
import Foundation
import Speech

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
        let line = String(data: data, encoding: .utf8) else {
    print("{\"error\":\"failed\"}")
    return
  }
  print(line)
}

func ms(since t0: Date) -> Int { Int(Date().timeIntervalSince(t0) * 1000) }

@available(macOS 26.0, *)
func runDictation(locale requested: Locale, url: URL) async -> [String: Any] {
  var out: [String: Any] = ["engine": "dictation"]
  guard let locale = await DictationTranscriber.supportedLocale(equivalentTo: requested) else {
    out["error"] = "locale-unsupported"
    return out
  }
  let module = DictationTranscriber(locale: locale, preset: .longDictation)
  do {
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
      try await request.downloadAndInstall()
    }
  } catch {
    out["error"] = "asset"
    return out
  }
  let file: AVAudioFile
  do {
    file = try AVAudioFile(forReading: url)
  } catch {
    out["error"] = "read"
    return out
  }
  let t0 = Date()
  do {
    let analyzer = SpeechAnalyzer(modules: [module])
    let collector = Task { () throws -> String in
      var text = ""
      for try await result in module.results { text += String(result.text.characters) }
      return text
    }
    if let last = try await analyzer.analyzeSequence(from: file) {
      try await analyzer.finalizeAndFinish(through: last)
    } else {
      await analyzer.cancelAndFinishNow()
    }
    out["text"] = try await collector.value
    out["ms"] = ms(since: t0)
  } catch {
    out["error"] = "failed"
  }
  return out
}

func runSF(locale: Locale, url: URL) async -> [String: Any] {
  var out: [String: Any] = ["engine": "sf"]
  let status: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { c in
    SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
  }
  guard status == .authorized else {
    out["error"] = "auth"
    return out
  }
  guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.supportsOnDeviceRecognition else {
    out["error"] = "locale-unsupported"
    return out
  }
  recognizer.queue = OperationQueue()
  let request = SFSpeechURLRecognitionRequest(url: url)
  request.requiresOnDeviceRecognition = true
  request.shouldReportPartialResults = false
  request.addsPunctuation = true
  let t0 = Date()
  let result: String? = await withCheckedContinuation { c in
    var done = false
    _ = recognizer.recognitionTask(with: request) { r, e in
      if done { return }
      if e != nil { done = true; c.resume(returning: nil); return }
      if let r, r.isFinal { done = true; c.resume(returning: r.bestTranscription.formattedString) }
    }
  }
  if let text = result {
    out["text"] = text
    out["ms"] = ms(since: t0)
  } else {
    out["error"] = "failed"
  }
  return out
}

@main
struct SpeechHelper {
  static func main() async {
    let args = CommandLine.arguments
    guard args.count == 3 else {
      emit(["error": "failed"])
      exit(2)
    }
    let locale = Locale(identifier: args[1])
    let url = URL(fileURLWithPath: args[2])
    let out: [String: Any]
    if #available(macOS 26.0, *) {
      out = await runDictation(locale: locale, url: url)
    } else {
      out = await runSF(locale: locale, url: url)
    }
    emit(out)
    exit(out["text"] == nil ? 1 : 0)
  }
}
