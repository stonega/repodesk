export function modelError(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  return (
    {
      search_provider_in_use:
        "Choose another search provider or disable search in each chat model before removing this one.",
      search_provider_not_found:
        "This search provider is unavailable. Reload saved settings and choose another provider.",
      search_provider_key_required:
        "Enter an API key for the selected search provider.",
      model_provider_auth_failed:
        "The provider rejected the API key. Check the key and try again.",
      model_discovery_failed:
        "Could not fetch models. Check the API base URL and try again.",
      model_discovery_invalid: "The provider did not return a model list.",
      model_provider_in_use:
        "Choose another provider for each service before removing this one.",
      model_not_available:
        "The selected model is no longer in the provider's model list.",
      model_price_tier_unavailable:
        "The selected price tier is no longer available. Choose the model again to review its current prices.",
      custom_model_pricing_required:
        "Enter both token prices in Advanced model settings for this custom model.",
      model_limits_required:
        "Enter the context window and maximum output in Advanced model settings for this custom model.",
      new_endpoint_requires_api_key:
        "Enter the API key again when changing the provider URL.",
      version_conflict:
        "Settings changed. Reload saved settings and try again.",
    }[code.split(".")[0] ?? code] ?? code
  );
}
