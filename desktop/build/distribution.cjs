/** Distribution variant shared by Vite, electron-builder and the release content gate. */
const value = process.env.FORSION_BUNDLE_EXTEND
if (value !== undefined && value !== '0' && value !== '1') {
  throw new Error('FORSION_BUNDLE_EXTEND must be 0 (without Extend) or 1 (with Extend)')
}
const bundleExtend = value !== '0'
module.exports = {
  bundleExtend,
  artifactSuffix: bundleExtend ? '' : '-NoExtend',
  updateChannel: bundleExtend ? 'latest' : 'latest-no-extend',
}
