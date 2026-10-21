declare module 'virtual:forsion-mobile-extend' {
  const bundle: {
    manifest: import('../../desktop/shared/amadeus/pluginSource').InstalledPluginManifest & { id: string; main: string }
    code: string
    readme: string
    changelog: string
    recipes: Array<{ slug: string; json: string; plugin: string }>
    testOnly: boolean
  }
  export default bundle
}
