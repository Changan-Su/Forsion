// Image-only contributions: registering never changes the current selection.
const image = (body) => 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">' + body + '</svg>')
const mark = '<rect x="8" y="8" width="240" height="240" rx="60" fill="#e5f0ed"/><circle cx="128" cy="128" r="46" fill="#477c71"/>'
ctx.registerAppearance?.({
  id: 'orbit', label: '青环', labelEn: 'Quiet orbit',
  icon: image(mark),
  splash: image(mark + '<circle cx="128" cy="128" r="82" fill="none" stroke="#477c71" stroke-width="5" stroke-dasharray="170 345"><animateTransform attributeName="transform" type="rotate" from="0 128 128" to="360 128 128" dur="3s" repeatCount="indefinite"/></circle>'),
})
