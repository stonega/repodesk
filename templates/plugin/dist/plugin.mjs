// .repodesk/sdk/plugin/index.ts
function definePlugin(definition) {
  return definition;
}

// src/index.ts
var src_default = definePlugin({
  tools: {
    async count_words({ text }, context) {
      context.signal.throwIfAborted();
      const count = text.trim().split(/\s+/).filter(Boolean).length;
      return {
        content: [{ type: "text", text: String(count) }],
        structuredContent: { count }
      };
    }
  }
});
export {
  src_default as default
};
