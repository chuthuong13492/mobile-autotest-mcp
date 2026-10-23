// DISC-003 throwaway prototype: Secure Enclave P-256 key gated by user presence; signs approval digests.
// Usage: al3helper create <label> | pubkey <label> | sign <label> <hex-digest>
import Foundation
import Security
func fail(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(1) }
let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage") }
let tag = "com.autotest.al3.\(args[2])".data(using: .utf8)!
func findKey() -> SecKey? {
  let q: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag, kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecReturnRef as String: true]
  var item: CFTypeRef?; let st = SecItemCopyMatching(q as CFDictionary, &item)
  return st == errSecSuccess ? (item as! SecKey) : nil
}
switch args[1] {
case "create":
  var err: Unmanaged<CFError>?
  guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &err) else { fail("acl: \(err!.takeRetainedValue())") }
  let attrs: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits as String: 256, kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
    kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: true, kSecAttrApplicationTag as String: tag, kSecAttrAccessControl as String: ac]]
  guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &err) else { fail("create: \(err!.takeRetainedValue())") }
  let pub = SecKeyCopyExternalRepresentation(SecKeyCopyPublicKey(key)!, nil)! as Data
  print(pub.base64EncodedString())
case "pubkey":
  guard let key = findKey() else { fail("not found") }
  print((SecKeyCopyExternalRepresentation(SecKeyCopyPublicKey(key)!, nil)! as Data).base64EncodedString())
case "sign":
  guard let key = findKey(), args.count >= 4 else { fail("not found") }
  var bytes = [UInt8](); var s = args[3]; while s.count >= 2 { bytes.append(UInt8(s.prefix(2), radix: 16)!); s = String(s.dropFirst(2)) }
  var err: Unmanaged<CFError>?
  guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureDigestX962SHA256, Data(bytes) as CFData, &err) else { fail("sign: \(err!.takeRetainedValue())") }
  print((sig as Data).base64EncodedString())
default: fail("unknown")
}
