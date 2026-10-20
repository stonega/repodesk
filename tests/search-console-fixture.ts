import { generateKeyPairSync } from "node:crypto";
export const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
export const account = {
  type: "service_account" as const,
  client_email: "repodesk@fixture.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
export const siteUrl = "sc-domain:example.com";
