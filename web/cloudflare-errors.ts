export function cloudflareError(cause: unknown) {
  const code = (cause as Error).message;
  if (code.includes("version_conflict"))
    return "Cloudflare settings changed in another session. Close the editor and reload saved settings before trying again.";
  const messages: Record<string, string> = {
    cloudflare_token_required:
      "Save an API token before choosing accounts and domains.",
    cloudflare_token_and_account_required:
      "Save an API token and choose an account before enabling Cloudflare.",
    cloudflare_credentials_unavailable:
      "Cloudflare credential storage is unavailable. Check the API and worker configuration.",
    cloudflare_access_denied:
      "Cloudflare denied access. Check the token’s resource restrictions and permissions. Account verification needs Account Settings Read. User tokens need User Memberships Read to discover accounts; if discovery is unavailable, enter IDs manually.",
    cloudflare_zone_denied:
      "A selected domain is unavailable or belongs to another account. Check your selection and token permissions.",
    cloudflare_oauth_account_denied:
      "The token cannot access the selected account. Check its account restrictions and Account Settings Read permission.",
    cloudflare_unavailable:
      "Couldn’t load Cloudflare resources. Try again shortly.",
    cloudflare_rate_limited:
      "Cloudflare is rate limiting requests. Try again shortly.",
    extension_tool_collision:
      "A file plugin already uses a Cloudflare tool name. Update its grants first.",
    invalid_request: "Check the API token, account and selected domains.",
    access_denied:
      "Only this workspace’s current deployment operator can configure Cloudflare.",
  };
  return messages[code] ?? code;
}
