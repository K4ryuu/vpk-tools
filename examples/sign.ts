/**
 * Sign an archive with an RSA key and verify it, vpk.exe style.
 * Generates a throwaway keypair so you can just run it.
 *
 * Run: bun run examples/sign.ts
 */
import { generateKeyPairSync } from "crypto";
import { VpkReader, VpkWriter } from "../src/index.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const signed = new VpkWriter().addFile("scripts/important.cfg", "sv_cheats 0").toBuffer({ sign: { privateKey } });

const vpk = VpkReader.fromBuffer(signed);
console.log("signature type:", vpk.signature?.type);
console.log("embedded key:  ", vpk.verifySignature());

// verify against your own trusted key instead of the embedded one
const pem = publicKey.export({ type: "spki", format: "pem" }) as string;
console.log("external key:  ", vpk.verifySignature(pem));

// tamper one byte -> signature and MD5s both blow up
const tampered = Buffer.from(signed);
tampered.writeUInt8(tampered.readUInt8(100) ^ 1, 100);
const broken = VpkReader.fromBuffer(tampered);
console.log("tampered:      ", broken.verifySignature());
