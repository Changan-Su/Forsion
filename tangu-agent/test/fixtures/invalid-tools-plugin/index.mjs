// Deliberately malformed runtime plugin, loaded only by the tool-definition regression harness.
export default {
  activate(ctx) {
    ctx.registerToolProvider({
      id: 'feedback-null-fixture',
      tools: () => [
        { name: 'fixture_missing_definition', execute: () => 'This invalid tool must never execute.' },
        null,
      ],
    });
    ctx.log('Invalid tool fixture registered');
  },
};
