import ExpoModulesCore
import Foundation

public class OllenyaMemoryAppleModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OllenyaMemoryApple")
    AsyncFunction("prepareDatabaseDirectory") { () throws -> String in
      let fileManager = FileManager.default
      var directory = try fileManager.url(
        for: .applicationSupportDirectory, in: .userDomainMask,
        appropriateFor: nil, create: true
      ).appendingPathComponent("OllenyaMemory", isDirectory: true)
      try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
      var attributes = URLResourceValues()
      attributes.isExcludedFromBackup = true
      try directory.setResourceValues(attributes)
      guard try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true else {
        throw NSError(domain: "OllenyaMemoryDirectory", code: 1)
      }
      return directory.absoluteString
    }
    AsyncFunction("capabilities") { () -> [String: Bool] in
      var ready = false
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) { ready = LocalMemoryApple.available() }
      #endif
      return ["available": ready, "italian": ready, "onDevice": ready, "ready": ready]
    }
    AsyncFunction("propose") { (utterance: String, contextJSON: String) async throws -> String in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        return try await LocalMemoryApple.propose(utterance: utterance, contextJSON: contextJSON)
      }
      #endif
      return "[]"
    }
  }
}
