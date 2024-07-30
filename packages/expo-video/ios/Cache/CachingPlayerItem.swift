import Foundation
import AVFoundation
import CryptoKit
import MobileCoreServices

public class CachingPlayerItem: AVPlayerItem {
  private var resourceLoaderDelegate: ResourceLoaderDelegate?
  private let url: URL
  private let initialScheme: String?
  private let saveFilePath: String
  private var customFileExtension: String?

  internal var urlRequestHeaders: [String: String]?

  /// Useful for keeping relevant model associated with CachingPlayerItem instance. This is a **strong** reference, be mindful not to create a **retain cycle**.
  public var passOnObject: Any?

  public convenience init(url: URL) {
    self.init(url: url, avUrlAssetOptions: nil)
  }

  init(url: URL, avUrlAssetOptions: [String: Any]? = nil) {
    let cachedMimeType = ResourceLoaderDelegate.readMimeType(forUrl: url)
    let cachedExtension = Self.mimeTypeToExtension(mimeType: cachedMimeType) ?? ""
    let fileExtension = url.pathExtension != "" ? url.pathExtension : cachedExtension
    let cachedVideoPath = Self.pathForUrl(url: url, fileExtension: fileExtension)

    self.url = url
    self.saveFilePath = cachedVideoPath
    self.initialScheme = URLComponents(url: url, resolvingAgainstBaseURL: false)?.scheme

    if FileManager.default.fileExists(atPath: cachedVideoPath) && fileExtension != "" {
      super.init(asset: AVURLAsset(url: URL(fileURLWithPath: cachedVideoPath), options: avUrlAssetOptions), automaticallyLoadedAssetKeys: nil)
      self.createCacheDirectoryIfNeeded()
      return
    }

    guard var urlWithCustomScheme = url.withScheme(VideoCacheManager.expoVideoCacheScheme) else {
      fatalError("CachingPlayerItem error: Urls without a scheme are not supported")
    }

    if let headers = avUrlAssetOptions?["AVURLAssetHTTPHeaderFieldsKey"] as? [String: String] {
      self.urlRequestHeaders = headers
    }

    let asset = AVURLAsset(url: urlWithCustomScheme, options: avUrlAssetOptions)
    super.init(asset: asset, automaticallyLoadedAssetKeys: nil)
    self.createCacheDirectoryIfNeeded()

    resourceLoaderDelegate = ResourceLoaderDelegate(url: url, saveFilePath: saveFilePath, fileExtension: fileExtension, owner: self)

    asset.resourceLoader.setDelegate(resourceLoaderDelegate, queue: DispatchQueue.main)
  }

  deinit {

    // Don't reference lazy `resourceLoaderDelegate` if it hasn't been called before.
    guard initialScheme != nil else { return }

    // Otherwise the ResourceLoaderDelegate wont deallocate and will keep downloading.
    resourceLoaderDelegate?.invalidateAndCancelSession()
  }

  // MARK: Public methods

  /// Downloads the media file. Works only with the initializers intended for play and cache.
  public func download() {
    // Make sure we are not initilalized with a filePath or non-caching init.
    guard initialScheme != nil else {
      assertionFailure("CachingPlayerItem error: Download method used on a non caching instance")
      return
    }

    resourceLoaderDelegate?.startDataRequest(with: url)
  }

  static func pathForUrl(url: URL, fileExtension: String) -> String {
    let hashedData = SHA256.hash(data: Data(url.absoluteString.utf8))
    let hashString = hashedData.compactMap { String(format: "%02x", $0) }.joined()
    let parsedExtension = fileExtension.starts(with: ".") || fileExtension == "" ? fileExtension : ("." + fileExtension)
    let hashFilename = hashString + parsedExtension

    guard var cachesDirectory = try? FileManager.default.url(for: .cachesDirectory,
                                                             in: .userDomainMask,
                                                             appropriateFor: nil,
                                                             create: true)
    else {
      fatalError("CachingPlayerItem error: Can't access default cache directory")
    }

    cachesDirectory.appendPathComponent(VideoCacheManager.expoVideoCacheScheme, isDirectory: true)
    cachesDirectory.appendPathComponent(hashFilename)

    return cachesDirectory.path
  }

  static func mimeTypeToExtension(mimeType: String?) -> String? {
    guard let mimeType else {
      return nil
    }
    guard let mimeUTI = UTTypeCreatePreferredIdentifierForTag(kUTTagClassMIMEType, mimeType as CFString, nil)?.takeUnretainedValue() else {
      return nil
    }
    return UTTypeCopyPreferredTagWithClass(mimeUTI, kUTTagClassFilenameExtension)?.takeRetainedValue() as? String
  }

  private func createCacheDirectoryIfNeeded() {
    guard var cachesDirectory = try? FileManager.default.url(for: .cachesDirectory,
                                                             in: .userDomainMask,
                                                             appropriateFor: nil,
                                                             create: true) 
    else {
      return
    }

    cachesDirectory.appendPathComponent(VideoCacheManager.expoVideoCacheScheme, isDirectory: true)
    try? FileManager.default.createDirectory(at: cachesDirectory, withIntermediateDirectories: true)
  }
}

extension URL {
  func withScheme(_ scheme: String) -> URL? {
    var components = URLComponents(url: self, resolvingAgainstBaseURL: false)
    components?.scheme = scheme
    return components?.url
  }
}

