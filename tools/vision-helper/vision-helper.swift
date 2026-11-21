// Helper for image classification labels and OCR (TODO 998, `npm run build:vision`). It uses Vision's `VNClassifyImageRequest` (classification) and
// `VNRecognizeTextRequest` (OCR, high accuracy, Japanese + English).
// The index process keeps it resident as a child process and hands it a one-line JSON header followed by that many (`size`) bytes of image content
// on stdin (stdout is one response per line). **It does not accept paths** (same as the PDF helper; review of TODO 1009):
// the index process opens and reads the file with O_NOFOLLOW (TODO 849). Opening a path here could follow symlinks.
//   request:  {"id":1,"size":12345,"minConfidence":0.1,"minSide":128,"maxSide":16384,"maxPixels":100000000,"decodeSide":2048,
//          "classify":true,"ocr":false,"ocrSide":3072,"ocrMaxChars":20000,"stripAspect":10,"maxAspect":40}\n<12345 bytes of image>
//   response: {"id":1,"ok":true,"w":1280,"h":960,"labels":[["dog",0.31],…],"cpuUs":5400}
//         When OCR was requested: "text":"…" (the characters read; empty if none) or "ocrFailed":true. A long thin strip (aspect ratio > stripAspect) is not classified and gets "strip":true.
//         {"id":1,"ok":false,"error":"decode"|"small"|"large"|"shape"|"classify","w":..,"h":..,"cpuUs":..}
// Decompression bomb (security review of wave 84): an image whose header dimensions exceed the limits (`maxSide` / `maxPixels`) is refused as `large` without decoding,
// and every other image is not expanded to all its pixels but shrunk to `decodeSide` px on the longest side before reading (`CGImageSourceCreateThumbnailAtIndex`).
// `cpuUs` is the CPU time this request used (µs, the difference of getrusage for this process). The index process's slow stage (pace.ts)
// counts the child's share too when deciding to rest. Classification (median 5-6 ms) and OCR (median 63 ms, worst case seconds) are separate requests: all images are classified first, and OCR is
// requested later, thinned out by the index process (stage 2). The per-image time limit (5 s) is enforced by the index process killing the child.
// It only reads images. It returns nothing except labels and OCR text. The text is not logged either. It exits when stdin closes. It never calls a model. It runs entirely on the device.
import Foundation
import ImageIO
import Vision

func reply(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

/// Reads `count` bytes after the header (from the same stdio stdin as `readLine`, so the buffer is shared). nil if there are not enough.
func readBody(_ count: Int) -> Data? {
  if count == 0 { return Data() }
  var data = Data(count: count)
  var got = 0
  let ok = data.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) -> Bool in
    guard let base = raw.baseAddress else { return false }
    while got < count {
      let n = fread(base + got, 1, count - got, stdin)
      if n == 0 { return false }
      got += n
    }
    return true
  }
  return ok ? data : nil
}

/// CPU time of this process (µs, user + system. Includes the other threads Vision uses).
func cpuMicros() -> Int {
  var usage = rusage()
  getrusage(RUSAGE_SELF, &usage)
  let user = Int(usage.ru_utime.tv_sec) * 1_000_000 + Int(usage.ru_utime.tv_usec)
  let system = Int(usage.ru_stime.tv_sec) * 1_000_000 + Int(usage.ru_stime.tv_usec)
  return user + system
}

/// Upper limit on the content (32 MB, same as the index process's `MAX_FILE_BYTES`). A header over it is treated as out of sync and we exit.
let maxSize = 32 * 1024 * 1024

while let line = readLine(strippingNewline: true) {
  guard let header = line.data(using: .utf8),
    let request = (try? JSONSerialization.jsonObject(with: header)) as? [String: Any],
    let id = request["id"] as? Int,
    let size = request["size"] as? Int,
    size >= 0, size <= maxSize
  else { exit(2) }  // Without a readable header the boundary of the following bytes is unknown. If it dies, the index process recreates it.
  guard let body = readBody(size) else { exit(0) }
  let minConfidence = Float(request["minConfidence"] as? Double ?? 0.1)
  let minSide = request["minSide"] as? Int ?? 128
  // The limits are passed by the caller. If absent (an old caller), the same defaults apply. 0 or less falls back to the default (no way to lift the limit).
  let maxSide = max(1, min(request["maxSide"] as? Int ?? 16384, 16384))
  let maxPixels = max(1, min(request["maxPixels"] as? Int ?? 100_000_000, 100_000_000))
  let decodeSide = max(64, min(request["decodeSide"] as? Int ?? 2048, 4096))
  let started = cpuMicros()
  let doClassify = request["classify"] as? Bool ?? true
  let doOcr = request["ocr"] as? Bool ?? false
  let ocrSide = max(256, min(request["ocrSide"] as? Int ?? 3072, 8192))
  let ocrMaxChars = max(1, min(request["ocrMaxChars"] as? Int ?? 20000, 100_000))
  let stripAspect = max(1.0, request["stripAspect"] as? Double ?? 10.0)
  let maxAspect = max(stripAspect, request["maxAspect"] as? Double ?? 40.0)
  autoreleasepool {
    guard let source = CGImageSourceCreateWithData(body as CFData, nil), CGImageSourceGetCount(source) > 0 else {
      reply(["id": id, "ok": false, "error": "decode", "cpuUs": cpuMicros() - started])
      return
    }
    let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    let w = props?[kCGImagePropertyPixelWidth] as? Int ?? 0
    let h = props?[kCGImagePropertyPixelHeight] as? Int ?? 0
    // Do not expand an image whose dimensions cannot be read (without the dimensions the limits cannot be applied).
    if w <= 0 || h <= 0 {
      reply(["id": id, "ok": false, "error": "decode", "cpuUs": cpuMicros() - started])
      return
    }
    // Do not classify tiny images (icon-sized) (spike 39: labels for a longest side under 128 px are only wrong or generic). They are not decoded either.
    if max(w, h) < minSide {
      reply(["id": id, "ok": false, "error": "small", "w": w, "h": h, "cpuUs": cpuMicros() - started])
      return
    }
    // Dimension limits (decompression bomb). Past this point w and h are at most 16,384, so the product cannot overflow.
    if max(w, h) > maxSide || w * h > maxPixels {
      reply(["id": id, "ok": false, "error": "large", "w": w, "h": h, "cpuUs": cpuMicros() - started])
      return
    }
    // Extreme aspect ratios (line- or rule-like images) are neither classified nor OCRed. A strip whose aspect ratio exceeds stripAspect (a banner, stitched screens) is
    // only not classified (shrinking it crushes one side and the labels become unreliable). OCR reads the strip as it is.
    let aspect = Double(max(w, h)) / Double(min(w, h))
    if aspect > maxAspect {
      reply(["id": id, "ok": false, "error": "shape", "w": w, "h": h, "cpuUs": cpuMicros() - started])
      return
    }
    let strip = aspect > stripAspect
    var out: [String: Any] = ["id": id, "ok": true, "w": w, "h": h]
    if strip { out["strip"] = true }

    // Do not expand all pixels; shrink to `side` on the longest side and read (never scale up). The EXIF orientation is baked in when shrinking (passed to Vision as .up).
    func thumbnail(_ side: Int) -> CGImage? {
      let thumbOptions: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: min(side, max(w, h)),
        kCGImageSourceShouldCacheImmediately: true,
      ]
      return CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOptions as CFDictionary)
    }

    if doClassify && !strip {
      guard let image = thumbnail(decodeSide) else {
        reply(["id": id, "ok": false, "error": "decode", "w": w, "h": h, "cpuUs": cpuMicros() - started])
        return
      }
      let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
      let classify = VNClassifyImageRequest()
      do {
        try handler.perform([classify])
      } catch {
        reply(["id": id, "ok": false, "error": "classify", "w": w, "h": h, "cpuUs": cpuMicros() - started])
        return
      }
      // Round confidence to 3 digits (Vision's trailing digits vary from run to run; spike 39: 2 of 167 images).
      out["labels"] = (classify.results ?? [])
        .filter { $0.confidence >= minConfidence }
        .map { [$0.identifier, (Double($0.confidence) * 1000).rounded() / 1000] as [Any] }
    } else {
      out["labels"] = [] as [Any]
    }

    if doOcr {
      // OCR reads at a larger size than classification (spike 39: characters were missed at 1600 px). A strip is read longer by its aspect ratio (at most 4x), and
      // the pixel count is capped at 36 MP. Together with the header dimension limit (maxPixels), the upper bound on the expansion size does not change.
      var side = min(Int(Double(ocrSide) * min(aspect, 4.0)), 16384)
      side = min(side, Int((36_000_000.0 * aspect).squareRoot()))
      if let image = thumbnail(side) {
        let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["ja-JP", "en-US"]
        request.usesLanguageCorrection = true
        do {
          try handler.perform([request])
          // Top to bottom (the order Vision returns). One candidate per line. The length is cut at the limit (in characters, never in the middle of a surrogate pair).
          let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
          var text = ""
          var count = 0
          for line in lines {
            if count >= ocrMaxChars { break }
            let piece = String(line.prefix(ocrMaxChars - count))
            text += (text.isEmpty ? "" : "\n") + piece
            count += piece.count + 1
          }
          out["text"] = text
        } catch {
          out["ocrFailed"] = true
        }
      } else {
        out["ocrFailed"] = true
      }
    }
    out["cpuUs"] = cpuMicros() - started
    reply(out)
  }
}
