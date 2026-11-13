// sdk/plugin/index.ts
function definePlugin(definition) {
  return definition;
}

// examples/plugins/repository-insights/src/index.ts
var src_default = definePlugin({
  tools: {
    async repository_summary({ repositoryId }, context) {
      context.signal.throwIfAborted();
      const data = await context.github.getRepository({ repositoryId });
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data
      };
    }
  }
});
export {
  src_default as default
};
