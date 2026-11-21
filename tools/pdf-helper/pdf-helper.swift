// Helper that extracts the body text of a PDF (TODO 1009, `npm run build:pdf`). It uses PDFKit's `PDFPage.string`.
// The index process keeps it resident as a child process and hands it a one-line JSON header followed by that many (`size`) bytes of PDF content
// on stdin (stdout is one response per line). **It does not accept paths** (review of TODO 1009): the index process
// opens and reads the file with O_NOFOLLOW (TODO 849). Opening a path here would follow symlinks and could read files outside the index.
//   request:  {"id":1,"size":12345,"maxBytes":262144,"maxPages":2000}\n<12345 bytes of PDF>
//   response: {"id":1,"ok":true,"text":"…","pages":12,"truncated":false}
//         {"id":1,"ok":false,"error":"open"|"locked"}
// Every response carries `cpuUs` (CPU time this request used, in µs, the difference of getrusage for this process). The index process's slow stage (pace.ts)
// counts the child's share too when deciding to rest (TODO 1226, same as the image helper).
// `pageLengths` is the length each page occupies in `text` (page body + the separating newline, in UTF-16 units = JS `length`).
// Summing from the start gives where each page begins (wave 63, to map full-text search hits to pages).
// The body text exists only in the response (it is not kept in any file either; constraint 9). It exits when stdin closes. It never calls a model.
// If a broken PDF crashes it, only this child dies (the index process recreates it on the next request).
import Foundation
import PDFKit

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

/// CPU time of this process (µs, user + system).
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
  let maxBytes = request["maxBytes"] as? Int ?? 262_144
  let maxPages = request["maxPages"] as? Int ?? 2000
  let started = cpuMicros()
  autoreleasepool {
    guard let doc = PDFDocument(data: body) else {
      reply(["id": id, "ok": false, "error": "open", "cpuUs": cpuMicros() - started])
      return
    }
    if doc.isLocked {
      reply(["id": id, "ok": false, "error": "locked", "cpuUs": cpuMicros() - started])
      return
    }
    var text = ""
    var bytes = 0
    var truncated = false
    var pageLengths: [Int] = []
    let total = doc.pageCount
    var page = 0
    while page < total {
      if page >= maxPages || bytes >= maxBytes {
        truncated = true
        break
      }
      let pageText = doc.page(at: page)?.string ?? ""
      // A page separator is a single newline (no form feed, which would mix into search terms).
      text += pageText
      text += "\n"
      bytes += pageText.utf8.count + 1
      pageLengths.append(pageText.utf16.count + 1)
      page += 1
    }
    reply(["id": id, "ok": true, "text": text, "pages": total, "pageLengths": pageLengths, "truncated": truncated, "cpuUs": cpuMicros() - started])
  }
}
